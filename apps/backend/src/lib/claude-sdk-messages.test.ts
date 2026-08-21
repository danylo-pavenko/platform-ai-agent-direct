import { describe, expect, it, vi } from 'vitest';
import { consumeSdkMessages, type SdkAgentMessage } from './claude-sdk-messages.js';

async function* from(messages: SdkAgentMessage[]) {
  for (const msg of messages) yield msg;
}

describe('consumeSdkMessages', () => {
  it('maps assistant text, session id, and native tool_use', async () => {
    const response = await consumeSdkMessages(
      from([
        { type: 'system', subtype: 'init', session_id: 'sess-abc', tools: [] } as SdkAgentMessage,
        {
          type: 'assistant',
          session_id: 'sess-abc',
          message: {
            content: [
              { type: 'text', text: 'Шукаю вікна.' },
              { type: 'tool_use', name: 'get_available_slots', input: { date: '21.08.2026' } },
            ],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-abc', result: 'Шукаю вікна.', is_error: false },
      ]),
    );

    expect(response.sessionId).toBe('sess-abc');
    expect(response.text).toBe('Шукаю вікна.');
    expect(response.toolCalls).toEqual([
      { name: 'get_available_slots', args: { date: '21.08.2026' } },
    ]);
    expect(response.fallback).toBeUndefined();
  });

  it('emits text_delta events', async () => {
    const onDelta = vi.fn();
    await consumeSdkMessages(
      from([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'При' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'віт' } },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Привіт' }] },
        },
        { type: 'result', subtype: 'success', result: 'Привіт', is_error: false },
      ]),
      { onDelta },
    );
    expect(onDelta.mock.calls.map((c) => c[0])).toEqual(['При', 'віт']);
  });

  it('marks rate-limit / unusable result as timeout fallback', async () => {
    const response = await consumeSdkMessages(
      from([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: "You've hit your session limit · resets 9am" }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 429,
          result: "You've hit your session limit",
        },
      ]),
    );
    expect(response.fallback).toBe('timeout');
    expect(response.errorDetail).toMatch(/429|session limit/i);
  });

  it('falls back on empty stream', async () => {
    const response = await consumeSdkMessages(from([]));
    expect(response.fallback).toBe('timeout');
    expect(response.errorDetail).toBe('empty sdk result');
  });

  it('falls back on execution error subtype', async () => {
    const response = await consumeSdkMessages(
      from([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['spawn failed'],
        },
      ]),
    );
    expect(response.fallback).toBe('timeout');
    expect(response.errorDetail).toContain('error_during_execution');
  });

  it('strips mcp__platform__ prefix and records MCP lookup results', async () => {
    const response = await consumeSdkMessages(
      from([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'mcp__platform__search_services',
                input: { query: 'манікюр' },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-1',
                content: '[search_services] РЕЗУЛЬТАТ:\nМанікюр 400–800 ₴',
              },
            ],
          },
        },
        { type: 'result', subtype: 'success', result: '', is_error: false },
      ]),
    );
    expect(response.toolCalls).toEqual([{ name: 'search_services', args: { query: 'манікюр' } }]);
    expect(response.lookupResults).toEqual([
      { name: 'search_services', result: '[search_services] РЕЗУЛЬТАТ:\nМанікюр 400–800 ₴' },
    ]);
  });
});
