import { describe, expect, it } from 'vitest';
import {
  looksLikeClaudeStreamJsonDump,
  parseClaudeStreamJson,
} from './claude-stream-parse.js';

/** Captured from tenant TKP — Claude Code 2.1.220 session limit (429). */
const RATE_LIMIT_NDJSON = `{"type":"system","subtype":"init","cwd":"/home/tkp/tenant_knowledge/.claude-spawn","session_id":"a74d2edb-d7df-475f-ad7f-2c89def2ca88","model":"claude-sonnet-5","apiKeySource":"none","claude_code_version":"2.1.220"}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"},"uuid":"bfe2b119-ffc3-4216-843e-7fc818dcae90","session_id":"a74d2edb-d7df-475f-ad7f-2c89def2ca88"}
{"type":"assistant","message":{"id":"ae544ddf-70e7-43c5-a64e-dbb0d7efd891","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You've hit your session limit · resets 9am (Europe/Berlin)"}],"usage":{"input_tokens":0,"output_tokens":0}},"parent_tool_use_id":null,"session_id":"a74d2edb-d7df-475f-ad7f-2c89def2ca88","error":"rate_limit","is_api_error_message":true}
{"is_error":true,"subtype":"success","api_error_status":429,"result":"You've hit your session limit · resets 9am (Europe/Berlin)","type":"result","duration_ms":864}`;

describe('parseClaudeStreamJson', () => {
  it('does not leak rate-limit NDJSON as customer text', () => {
    const parsed = parseClaudeStreamJson(RATE_LIMIT_NDJSON);
    expect(parsed.text).toBe('');
    expect(parsed.unusable).toBe(true);
    expect(parsed.errorDetail).toMatch(/429|session limit/i);
  });

  it('parses nested message.content assistant replies', () => {
    const raw = [
      '{"type":"system","subtype":"init"}',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Привіт! Чим допомогти?' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'Привіт! Чим допомогти?',
        is_error: false,
      }),
    ].join('\n');

    expect(parseClaudeStreamJson(raw)).toEqual({
      text: 'Привіт! Чим допомогти?',
    });
  });

  it('skips is_error result and returns empty when nothing else usable', () => {
    const raw = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Not logged in · Please run /login',
    });
    const parsed = parseClaudeStreamJson(raw);
    expect(parsed.text).toBe('');
    expect(parsed.unusable).toBe(true);
  });
});

describe('looksLikeClaudeStreamJsonDump', () => {
  it('detects multi-line stream-json', () => {
    expect(looksLikeClaudeStreamJsonDump(RATE_LIMIT_NDJSON)).toBe(true);
    expect(looksLikeClaudeStreamJsonDump('Привіт клієнту')).toBe(false);
  });
});
