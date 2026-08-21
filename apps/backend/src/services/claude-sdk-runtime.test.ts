import { describe, expect, it, vi } from 'vitest';
import type { SdkAgentMessage } from '../lib/claude-sdk-messages.js';
import type { ClaudeRequest, ClaudeRuntime } from '../lib/claude-runtime.js';

vi.mock('../config.js', () => ({
  config: {
    CLAUDE_MODEL: 'sonnet',
    CLAUDE_RUNTIME: 'sdk',
    CLAUDE_MAX_CONCURRENCY: 2,
    CLAUDE_META_MAX_CONCURRENCY: 1,
    CLAUDE_TIMEOUT_MS: 120_000,
    CLAUDE_ADMIN_TIMEOUT_MS: 120_000,
    CLAUDE_QUOTA_SOFT_PERCENT: 90,
    INSTANCE_ID: 'test',
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { agentInvocation: { create: vi.fn() } } }));

const { evaluateClaudeSpawn } = vi.hoisted(() => ({
  evaluateClaudeSpawn: vi.fn(() => ({
    allowed: true,
    hardBlock: false,
    softBudget: false,
    reason: null as string | null,
  })),
}));

vi.mock('../lib/claude-quota-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/claude-quota-gate.js')>();
  return {
    ...actual,
    evaluateClaudeSpawn,
    noteClaudeRateLimit: vi.fn(),
  };
});

vi.mock('./claude-quota.js', () => ({
  recordClaudeRateLimit: vi.fn(),
  releaseExpiredClaudeQuotaIfNeeded: vi.fn(async () => undefined),
}));

import { createSdkClaudeRuntime } from './claude-sdk-runtime.js';
import { CUSTOMER_FALLBACK_TIMEOUT } from '../lib/agent-fallback-defaults.js';
import { CLAUDE_SDK_DISALLOWED_TOOLS } from '../lib/claude-runtime.js';

const baseReq: ClaudeRequest = {
  systemPrompt: 'You are a booking agent.',
  conversationHistory: [],
  userMessage: 'хочу манікюр',
};

function queryFrom(messages: SdkAgentMessage[]) {
  const close = vi.fn();
  const query = vi.fn((params: { prompt: string; options?: Record<string, unknown> }) => {
    const gen = (async function* () {
      for (const msg of messages) yield msg;
    })();
    return Object.assign(gen, { close });
  });
  return { query, close };
}

describe('createSdkClaudeRuntime', () => {
  it('calls query() with lockdown options and maps the result', async () => {
    const { query, close } = queryFrom([
      {
        type: 'assistant',
        session_id: 'sess-sdk',
        message: { content: [{ type: 'text', text: 'Манікюр від 400 ₴.' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-sdk',
        result: 'Манікюр від 400 ₴.',
        is_error: false,
      },
    ]);

    const runtime = createSdkClaudeRuntime({ query: query as never });
    const response = await runtime.complete(baseReq, {
      timeoutMs: 5_000,
      model: 'sonnet',
      context: { channel: 'instagram' },
    });

    expect(query).toHaveBeenCalledTimes(1);
    const passed = query.mock.calls[0][0];
    expect(passed.prompt).toContain('хочу манікюр');
    expect(passed.prompt).not.toContain('<system>');
    expect(passed.options.systemPrompt).toBe('You are a booking agent.');
    expect(passed.options.tools).toEqual([]);
    expect(passed.options.disallowedTools).toEqual([...CLAUDE_SDK_DISALLOWED_TOOLS]);
    expect(passed.options.permissionMode).toBe('dontAsk');
    expect(passed.options.maxTurns).toBe(1);
    expect(passed.options.resume).toBeUndefined();
    expect(response.text).toBe('Манікюр від 400 ₴.');
    expect(response.sessionId).toBe('sess-sdk');
    expect(response.fallback).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it('passes resume session id and a slim prompt', async () => {
    const { query } = queryFrom([
      {
        type: 'assistant',
        session_id: 'sess-2',
        message: { content: [{ type: 'text', text: 'Ок.' }] },
      },
      { type: 'result', subtype: 'success', session_id: 'sess-2', result: 'Ок.', is_error: false },
    ]);

    await createSdkClaudeRuntime({ query: query as never }).complete(
      { ...baseReq, resumeSessionId: 'sess-2', userMessage: '[slots] 10:00' },
      { timeoutMs: 5_000, model: 'haiku', context: { channel: 'instagram' } },
    );

    const passed = query.mock.calls[0][0];
    expect(passed.options.resume).toBe('sess-2');
    expect(passed.prompt).toBe('Human: [slots] 10:00');
    expect(passed.options.model).toBe('haiku');
  });

  it('does not call query when quota gate denies', async () => {
    evaluateClaudeSpawn.mockReturnValueOnce({
      allowed: false,
      hardBlock: true,
      softBudget: false,
      reason: 'session_exhausted',
    });
    const { query } = queryFrom([]);
    const response = await createSdkClaudeRuntime({ query: query as never }).complete(baseReq, {
      timeoutMs: 5_000,
      model: 'sonnet',
      context: { channel: 'instagram' },
    });
    expect(query).not.toHaveBeenCalled();
    expect(response.fallback).toBe('timeout');
    expect(response.errorDetail).toContain('quota_gate');
  });

  it('uses explicit CLI runtime for vision turns', async () => {
    const { query } = queryFrom([]);
    const cliComplete = vi.fn(async () => ({ text: 'Бачу фото нігтів.' }));
    const cliRuntime: ClaudeRuntime = {
      kind: 'cli',
      complete: cliComplete,
      stream: cliComplete,
      warmup: cliComplete,
    };

    const response = await createSdkClaudeRuntime({
      query: query as never,
      cliRuntime,
    }).complete(
      { ...baseReq, images: ['/tmp/nail.jpg'] },
      { timeoutMs: 5_000, model: 'sonnet', context: { channel: 'sandbox' } },
    );

    expect(query).not.toHaveBeenCalled();
    expect(cliComplete).toHaveBeenCalledTimes(1);
    expect(response.text).toBe('Бачу фото нігтів.');
  });

  it('times out and closes the query', async () => {
    const close = vi.fn();
    const query = vi.fn(() => {
      let rejectWait: ((err: Error) => void) | undefined;
      const wait = new Promise<never>((_, reject) => {
        rejectWait = reject;
      });
      const gen = (async function* () {
        await wait;
        yield { type: 'assistant' } as SdkAgentMessage;
      })();
      return Object.assign(gen, {
        interrupt: vi.fn(async () => undefined),
        close: () => {
          close();
          rejectWait?.(new Error('closed'));
        },
      });
    });

    const response = await createSdkClaudeRuntime({ query: query as never }).complete(baseReq, {
      timeoutMs: 20,
      model: 'sonnet',
      context: { channel: 'instagram' },
    });

    expect(response.fallback).toBe('timeout');
    expect(response.text).toBe(CUSTOMER_FALLBACK_TIMEOUT);
    expect(close).toHaveBeenCalled();
  });

  it('forwards stream deltas when onDelta is set', async () => {
    const { query } = queryFrom([
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      },
      {
        type: 'assistant',
        session_id: 's',
        message: { content: [{ type: 'text', text: 'Hi' }] },
      },
      { type: 'result', subtype: 'success', session_id: 's', result: 'Hi', is_error: false },
    ]);
    const onDelta = vi.fn();
    await createSdkClaudeRuntime({ query: query as never }).stream(baseReq, {
      timeoutMs: 5_000,
      model: 'sonnet',
      context: { channel: 'meta_agent' },
      onDelta,
    });
    expect(query.mock.calls[0][0].options.includePartialMessages).toBe(true);
    expect(onDelta).toHaveBeenCalledWith('Hi');
  });

  it('registers lookup MCP tools without enabling Bash/Read', async () => {
    const { query } = queryFrom([
      {
        type: 'assistant',
        session_id: 's',
        message: { content: [{ type: 'text', text: 'Ок' }] },
      },
      { type: 'result', subtype: 'success', session_id: 's', result: 'Ок', is_error: false },
    ]);

    await createSdkClaudeRuntime({ query: query as never }).complete(
      {
        ...baseReq,
        tools: [
          {
            name: 'search_services',
            description: 'search',
            parameters: { type: 'object', properties: {} },
          },
          {
            name: 'book_appointment',
            description: 'book',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      { timeoutMs: 5_000, model: 'sonnet', context: { channel: 'instagram' } },
    );

    const passed = query.mock.calls[0][0];
    expect(passed.options.allowedTools).toEqual([
      'mcp__platform__search_services',
      'mcp__platform__book_appointment',
    ]);
    expect(passed.options.tools).toEqual([
      'mcp__platform__search_services',
      'mcp__platform__book_appointment',
    ]);
    expect(passed.options.mcpServers.platform).toBeDefined();
    expect(typeof passed.options.canUseTool).toBe('function');
    expect(passed.options.disallowedTools).toEqual([...CLAUDE_SDK_DISALLOWED_TOOLS]);
    expect(passed.prompt).toContain('book_appointment');
    expect(passed.prompt).not.toMatch(/<tool_call>\s*\{/);
    expect(passed.prompt).not.toMatch(/"name": "search_services"/);
  });

  it('warmup uses query() without MCP and a ping prompt', async () => {
    const { query } = queryFrom([
      {
        type: 'assistant',
        session_id: 'warm',
        message: { content: [{ type: 'text', text: 'OK' }] },
      },
      { type: 'result', subtype: 'success', session_id: 'warm', result: 'OK', is_error: false },
    ]);
    const response = await createSdkClaudeRuntime({ query: query as never }).warmup({
      timeoutMs: 5_000,
      model: 'haiku',
    });
    expect(response.text).toBe('OK');
    expect(query.mock.calls[0][0].options.tools).toEqual([]);
    expect(query.mock.calls[0][0].options.mcpServers).toBeUndefined();
    expect(query.mock.calls[0][0].prompt).toContain('ping');
  });
});
