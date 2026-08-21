/**
 * Shared post-processing for any Claude runtime (CLI or SDK).
 * Merges native tool_use with the text `<tool_call>` protocol and sanitizes
 * customer-facing prose. Safe to run twice (second pass is a no-op).
 */

import pino from 'pino';
import { sanitizeCustomerFacingReply } from './assistant-output.js';
import { parseToolCallsFromText, stripToolCallBlocks } from './parse-tool-calls.js';
import type { ClaudeResponse } from './claude-runtime.js';

const log = pino({ name: 'claude-finalize' });

export function finalizeClaudeResponse(response: ClaudeResponse): ClaudeResponse {
  if (response.fallback) return response;

  const parseText = response.usedTextToolProtocol !== false;
  const fromText = parseText ? parseToolCallsFromText(response.text) : [];
  const strippedTools = stripToolCallBlocks(response.text);
  const text = sanitizeCustomerFacingReply(strippedTools);
  if (text !== strippedTools.trim()) {
    log.info(
      {
        beforeChars: strippedTools.length,
        afterChars: text.length,
      },
      'Sanitized customer-facing Claude reply (artifacts / meta-reasoning)',
    );
  }
  const merged = [...(response.toolCalls ?? []), ...fromText];

  return {
    ...response,
    text,
    ...(merged.length > 0 ? { toolCalls: merged } : { toolCalls: undefined }),
  };
}
