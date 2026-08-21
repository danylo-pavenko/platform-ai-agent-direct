import { describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
const { evaluateClaudeSpawn } = vi.hoisted(() => ({
  evaluateClaudeSpawn: vi.fn(() => ({
    allowed: true,
    hardBlock: false,
    softBudget: false,
    reason: null as string | null,
  })),
}));
const { query } = vi.hoisted(() => ({
  query: vi.fn(() => {
    const close = vi.fn();
    const gen = (async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-sess',
        message: { content: [{ type: 'text', text: 'SDK ok' }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-sess',
        result: 'SDK ok',
        is_error: false,
      };
    })();
    return Object.assign(gen, { close });
  }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));

vi.mock('../lib/claude-quota-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/claude-quota-gate.js')>();
  return { ...actual, evaluateClaudeSpawn, noteClaudeRateLimit: vi.fn() };
});

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

import { createClaudeRuntime } from './claude-runtime-factory.js';
import { ADMIN_FALLBACK_TIMEOUT } from '../lib/claude-runtime.js';
import { CUSTOMER_FALLBACK_TIMEOUT } from '../lib/agent-fallback-defaults.js';

const baseReq = {
  systemPrompt: 'sys',
  conversationHistory: [] as { role: 'user' | 'assistant'; content: string }[],
  userMessage: 'hello',
};

describe('createClaudeRuntime', () => {
  it('defaults to SDK; cli is an explicit hotfix', () => {
    expect(createClaudeRuntime(undefined).kind).toBe('sdk');
    expect(createClaudeRuntime('bogus').kind).toBe('sdk');
    expect(createClaudeRuntime('sdk').kind).toBe('sdk');
    expect(createClaudeRuntime('cli').kind).toBe('cli');
  });

  it('default complete path uses query() and does not spawn claude -p', async () => {
    spawn.mockClear();
    query.mockClear();
    const runtime = createClaudeRuntime(undefined);
    expect(runtime.kind).toBe('sdk');

    const response = await runtime.complete(baseReq, {
      timeoutMs: 1_000,
      model: 'sonnet',
      context: { channel: 'instagram' },
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(response.text).toBe('SDK ok');
    expect(response.fallback).toBeUndefined();
  });

  it('SDK query failure uses admin fallback copy on teach channel', async () => {
    query.mockImplementationOnce(() => {
      const close = vi.fn();
      const gen = (async function* () {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['boom'],
        };
      })();
      return Object.assign(gen, { close });
    });

    const response = await createClaudeRuntime('sdk').stream(baseReq, {
      timeoutMs: 1_000,
      model: 'sonnet',
      context: { channel: 'meta_agent' },
    });
    expect(response.text).toBe(ADMIN_FALLBACK_TIMEOUT);
    expect(response.fallback).toBe('timeout');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('customer SDK error uses customer timeout copy', async () => {
    query.mockImplementationOnce(() => {
      const close = vi.fn();
      const gen = (async function* () {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['boom'],
        };
      })();
      return Object.assign(gen, { close });
    });

    const response = await createClaudeRuntime('sdk').complete(baseReq, {
      timeoutMs: 1_000,
      model: 'sonnet',
      context: { channel: 'instagram' },
    });
    expect(response.text).toBe(CUSTOMER_FALLBACK_TIMEOUT);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('SDK warmup uses query() not CLI spawn', async () => {
    spawn.mockClear();
    query.mockClear();
    const response = await createClaudeRuntime('sdk').warmup({
      timeoutMs: 1_000,
      model: 'haiku',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(response.fallback).toBeUndefined();
  });
});
