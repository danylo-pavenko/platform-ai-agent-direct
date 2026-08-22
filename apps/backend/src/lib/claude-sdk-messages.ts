/**
 * Map Claude Agent SDK stream messages onto our ClaudeResponse contract.
 * Intentionally duck-typed so unit tests do not spawn the bundled CLI.
 */

import { isClaudeRateLimitSignal } from './claude-auth-probe.js';
import { isUnusableClaudeResultText } from './claude-result-usable.js';
import type { ClaudeResponse } from './claude-runtime.js';
import { canonicalToolName } from './tool-definitions.js';

export type SdkContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: string | Array<{ type?: string; text?: string }>;
};

export type SdkAgentMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  api_error_status?: number | null;
  message?: { content?: SdkContentBlock[] };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
};

export interface ConsumeSdkMessagesOptions {
  onDelta?: (text: string) => void;
}

function extractAssistantText(msg: SdkAgentMessage): string {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function extractNativeToolCalls(
  msg: SdkAgentMessage,
  toolUseIds: Map<string, string>,
): { name: string; args: Record<string, unknown> }[] {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.trim()) {
      const name = canonicalToolName(block.name);
      const args =
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input
          : {};
      calls.push({ name, args });
      if (typeof block.id === 'string' && block.id) {
        toolUseIds.set(block.id, name);
      }
    }
  }
  return calls;
}

function extractToolResults(
  msg: SdkAgentMessage,
  toolUseIds: Map<string, string>,
): { name: string; result: string }[] {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return [];
  const results: { name: string; result: string }[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    const name =
      (typeof block.tool_use_id === 'string' && toolUseIds.get(block.tool_use_id)) ||
      (typeof block.name === 'string' ? canonicalToolName(block.name) : '');
    if (!name) continue;
    let result = '';
    if (typeof block.content === 'string') {
      result = block.content;
    } else if (Array.isArray(block.content)) {
      result = block.content
        .filter((c) => typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');
    } else if (typeof block.text === 'string') {
      result = block.text;
    }
    if (result) results.push({ name, result });
  }
  return results;
}

function extractDeltaText(msg: SdkAgentMessage): string | null {
  if (msg.type !== 'stream_event') return null;
  const event = msg.event;
  if (!event || event.type !== 'content_block_delta') return null;
  if (event.delta?.type !== 'text_delta') return null;
  return typeof event.delta.text === 'string' ? event.delta.text : null;
}

/** Claude Code may still report a turn cap as error_max_turns (legacy or implicit). */
export function isSdkMaxTurnsLimit(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v.includes('error_max_turns') || v.includes('maximum number of turns');
}

function collectErrorDetail(msg: SdkAgentMessage): string | undefined {
  if (msg.type !== 'result') return undefined;
  const isErr =
    msg.is_error === true ||
    msg.api_error_status === 429 ||
    (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'));
  if (!isErr) return undefined;

  const parts: string[] = [];
  if (typeof msg.subtype === 'string' && msg.subtype.startsWith('error')) {
    parts.push(msg.subtype);
  }
  if (typeof msg.result === 'string' && msg.result.trim()) {
    parts.push(msg.result.trim());
  }
  if (Array.isArray(msg.errors)) {
    for (const err of msg.errors) {
      if (typeof err === 'string' && err.trim()) parts.push(err.trim());
    }
  }
  if (msg.api_error_status === 429) parts.push('api_error_status:429');
  if (parts.length === 0) parts.push('sdk_result_is_error');
  return parts.join(' | ');
}

/**
 * Fold an SDK async iterator into one ClaudeResponse.
 * Does not apply customer-facing sanitize / `<tool_call>` merge — the facade does.
 */
export async function consumeSdkMessages(
  messages: AsyncIterable<SdkAgentMessage>,
  opts?: ConsumeSdkMessagesOptions,
): Promise<ClaudeResponse> {
  let text = '';
  let sessionId: string | undefined;
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const lookupResults: { name: string; result: string }[] = [];
  const toolUseIds = new Map<string, string>();
  let errorDetail: string | undefined;
  let sawError = false;
  let sawMessage = false;

  try {
    for await (const msg of messages) {
      sawMessage = true;
      if (typeof msg.session_id === 'string' && msg.session_id.trim()) {
        sessionId = msg.session_id.trim();
      }

      const delta = extractDeltaText(msg);
      if (delta) {
        opts?.onDelta?.(delta);
      }

      if (msg.type === 'assistant') {
        const chunk = extractAssistantText(msg);
        if (chunk) text = chunk;
        toolCalls.push(...extractNativeToolCalls(msg, toolUseIds));
      }

      if (msg.type === 'user') {
        lookupResults.push(...extractToolResults(msg, toolUseIds));
      }

      if (msg.type === 'result') {
        const detail = collectErrorDetail(msg);
        if (detail) {
          sawError = true;
          errorDetail = detail;
        }
        if (msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim()) {
          if (!text.trim()) text = msg.result;
        }
      }
    }
  } catch (err) {
    // query() throws after error_max_turns — keep any assistant text / tools.
    const message = err instanceof Error ? err.message : String(err);
    if (isSdkMaxTurnsLimit(message)) {
      errorDetail = errorDetail ? `${errorDetail} | ${message}` : message;
    } else {
      throw err;
    }
  }

  if (!sawMessage) {
    return {
      text: '',
      fallback: 'timeout',
      errorDetail: 'empty sdk result',
    };
  }

  const usable =
    text.trim().length > 0 || toolCalls.length > 0 || lookupResults.length > 0;
  if (isSdkMaxTurnsLimit(errorDetail) && usable) {
    return {
      text,
      ...(sessionId ? { sessionId } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(lookupResults.length > 0 ? { lookupResults } : {}),
    };
  }

  const combinedForSignals = [text, errorDetail ?? ''].join('\n');
  if (
    sawError ||
    isUnusableClaudeResultText(text) ||
    isClaudeRateLimitSignal(combinedForSignals)
  ) {
    return {
      text: text.trim() ? text : '',
      ...(sessionId ? { sessionId } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(lookupResults.length > 0 ? { lookupResults } : {}),
      fallback: 'timeout',
      errorDetail:
        errorDetail ??
        (isClaudeRateLimitSignal(combinedForSignals)
          ? combinedForSignals.slice(0, 500)
          : 'unusable sdk result'),
    };
  }

  if (!usable) {
    return {
      text: '',
      ...(sessionId ? { sessionId } : {}),
      fallback: 'timeout',
      errorDetail: errorDetail ?? 'empty sdk result',
    };
  }

  return {
    text,
    ...(sessionId ? { sessionId } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(lookupResults.length > 0 ? { lookupResults } : {}),
  };
}
