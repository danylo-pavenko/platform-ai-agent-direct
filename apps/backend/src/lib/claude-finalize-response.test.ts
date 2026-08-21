import { describe, expect, it } from 'vitest';
import { finalizeClaudeResponse } from './claude-finalize-response.js';
import type { ClaudeResponse } from './claude-runtime.js';

describe('finalizeClaudeResponse', () => {
  it('extracts <tool_call> blocks and strips them from customer text', () => {
    const out = finalizeClaudeResponse({
      text: `Записую на 10:00.

<tool_call>
{"name":"book_appointment","args":{"date":"21.08.2026"}}
</tool_call>`,
    });
    expect(out.text).toContain('Записую на 10:00');
    expect(out.text).not.toContain('<tool_call>');
    expect(out.toolCalls).toEqual([
      { name: 'book_appointment', args: { date: '21.08.2026' } },
    ]);
  });

  it('merges native tool_use with text protocol', () => {
    const out = finalizeClaudeResponse({
      text: `Ок.

<tool_call>
{"name":"tag_client","args":{"tags":["hot"]}}
</tool_call>`,
      toolCalls: [{ name: 'search_services', args: { query: 'манікюр' } }],
    });
    expect(out.toolCalls?.map((c) => c.name)).toEqual(['search_services', 'tag_client']);
  });

  it('does not rewrite canned fallbacks', () => {
    const fallback: ClaudeResponse = {
      text: 'Одну хвилинку, менеджер відпише трохи пізніше.',
      fallback: 'timeout',
      errorDetail: 'sdk_runtime_not_implemented',
    };
    expect(finalizeClaudeResponse(fallback)).toEqual(fallback);
  });

  it('is idempotent after tool blocks are stripped', () => {
    const once = finalizeClaudeResponse({
      text: `Дякую.

<tool_call>
{"name":"update_client_info","args":{"phone":"+380991112233"}}
</tool_call>`,
    });
    const twice = finalizeClaudeResponse(once);
    expect(twice).toEqual(once);
    expect(twice.toolCalls).toHaveLength(1);
  });

  it('does not parse text <tool_call> on the SDK native path (still strips from customer text)', () => {
    const out = finalizeClaudeResponse({
      text: `Записую.

<tool_call>
{"name":"book_appointment","args":{"date":"21.08.2026"}}
</tool_call>`,
      toolCalls: [{ name: 'update_client_info', args: { phone: '+38099' } }],
      usedTextToolProtocol: false,
    });
    expect(out.text).not.toContain('<tool_call>');
    expect(out.toolCalls).toEqual([{ name: 'update_client_info', args: { phone: '+38099' } }]);
  });
});
