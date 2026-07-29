/**
 * Parse Claude Code `--output-format stream-json` NDJSON stdout into a reply.
 *
 * Claude Code ≥2.1.x nests assistant content under `message.content` and may
 * exit 0 with `subtype: "success"` even on 429 rate limits — never fall back
 * to dumping the raw NDJSON stream to customers.
 */

import { isUnusableClaudeResultText } from './claude-result-usable.js';

export interface ParsedClaudeStream {
  text: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** True when stdout only contained API/auth/rate-limit stubs. */
  unusable?: boolean;
  errorDetail?: string;
}

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

function extractContentBlocks(obj: Record<string, unknown>): ContentBlock[] | null {
  if (Array.isArray(obj.content)) {
    return obj.content as ContentBlock[];
  }
  const message = obj.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const nested = (message as Record<string, unknown>).content;
    if (Array.isArray(nested)) return nested as ContentBlock[];
  }
  return null;
}

function isApiErrorAssistantEvent(obj: Record<string, unknown>): boolean {
  if (obj.is_api_error_message === true) return true;
  if (obj.error === 'rate_limit' || obj.error === 'authentication_failed') return true;
  const message = obj.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const m = message as Record<string, unknown>;
    if (m.error === 'rate_limit' || m.is_api_error_message === true) return true;
    // Synthetic rate-limit stubs use model "<synthetic>"
    if (m.model === '<synthetic>' && Array.isArray(m.content)) {
      const text = (m.content as ContentBlock[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n');
      if (isUnusableClaudeResultText(text)) return true;
    }
  }
  return false;
}

/** True when raw stdout looks like Claude stream-json NDJSON (not prose). */
export function looksLikeClaudeStreamJsonDump(text: string): boolean {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;

  let typed = 0;
  for (const line of lines.slice(0, 8)) {
    if (!line.startsWith('{')) return false;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.type === 'string') typed += 1;
    } catch {
      return false;
    }
  }
  return typed >= 2;
}

/**
 * Walk stream-json lines (newest first) and pick the last usable assistant result.
 */
export function parseClaudeStreamJson(raw: string): ParsedClaudeStream {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let sawErrorResult = false;
  let errorDetail: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>;

      if (obj.type === 'result' && typeof obj.result === 'string') {
        if (
          obj.is_error === true ||
          typeof obj.api_error_status === 'number' ||
          isUnusableClaudeResultText(obj.result)
        ) {
          sawErrorResult = true;
          errorDetail =
            typeof obj.api_error_status === 'number'
              ? `api_error ${obj.api_error_status}: ${obj.result}`
              : obj.result;
          continue;
        }
        return { text: obj.result };
      }

      if (obj.type === 'rate_limit_event') {
        sawErrorResult = true;
        errorDetail = errorDetail ?? 'rate_limit_event';
        continue;
      }

      if (obj.type === 'assistant') {
        if (isApiErrorAssistantEvent(obj)) {
          sawErrorResult = true;
          const blocks = extractContentBlocks(obj);
          const errText = blocks
            ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text!)
            .join('\n');
          if (errText) errorDetail = errorDetail ?? errText;
          continue;
        }

        const blocks = extractContentBlocks(obj);
        if (!blocks) continue;

        const textParts: string[] = [];
        const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            toolCalls.push({
              name: block.name,
              args: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }

        const joined = textParts.join('\n');
        if (isUnusableClaudeResultText(joined) && toolCalls.length === 0) {
          sawErrorResult = true;
          errorDetail = errorDetail ?? joined;
          continue;
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          return {
            text: joined,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
        }
      }

      if (typeof obj.text === 'string' && obj.text.length > 0 && !obj.type) {
        if (isUnusableClaudeResultText(obj.text)) {
          sawErrorResult = true;
          continue;
        }
        return { text: obj.text };
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', unusable: true, errorDetail: errorDetail ?? 'empty stdout' };
  }

  // Never ship NDJSON / stream envelopes to Instagram.
  if (looksLikeClaudeStreamJsonDump(trimmed) || sawErrorResult) {
    return {
      text: '',
      unusable: true,
      errorDetail: errorDetail ?? 'unusable stream-json (rate limit or parse miss)',
    };
  }

  if (isUnusableClaudeResultText(trimmed)) {
    return { text: '', unusable: true, errorDetail: trimmed };
  }

  return { text: trimmed };
}
