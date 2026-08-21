import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { evaluateClaudeSpawn, queueState } = vi.hoisted(() => ({
  evaluateClaudeSpawn: vi.fn(),
  queueState: { pending: 0 },
}));

vi.mock('../config.js', () => ({
  config: {
    CLAUDE_MODEL: 'sonnet',
    CLAUDE_RUNTIME: 'cli',
    CLAUDE_MAX_CONCURRENCY: 2,
    CLAUDE_META_MAX_CONCURRENCY: 1,
    CLAUDE_TIMEOUT_MS: 120_000,
    CLAUDE_ADMIN_TIMEOUT_MS: 120_000,
    CLAUDE_QUOTA_SOFT_PERCENT: 90,
    INSTANCE_ID: 'test',
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    agentInvocation: { create: vi.fn(() => Promise.resolve()) },
  },
}));

vi.mock('../lib/queue.js', () => ({
  Semaphore: class {
    get pending() {
      return queueState.pending;
    }
    get active() {
      return 0;
    }
    async acquire() {
      return () => undefined;
    }
  },
}));

vi.mock('../lib/claude-quota-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/claude-quota-gate.js')>();
  return {
    ...actual,
    evaluateClaudeSpawn: (...args: Parameters<typeof actual.evaluateClaudeSpawn>) =>
      evaluateClaudeSpawn(...args),
  };
});

vi.mock('./claude-quota.js', () => ({
  recordClaudeRateLimit: vi.fn(),
  releaseExpiredClaudeQuotaIfNeeded: vi.fn(async () => undefined),
}));

vi.mock('../lib/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-config.js')>();
  return {
    ...actual,
    getAgentConfig: vi.fn(async () => ({
      mode: 'sales',
      outOfHoursStrategy: 'warn_early',
      managerSlaHoursBusiness: 2,
      sessionFreshnessDays: 14,
      responseDelayMinSeconds: 0,
      responseDelayMaxSeconds: 0,
      claudeModel: 'sonnet',
    })),
  };
});

import { askClaude, askClaudeStream, setClaudeRuntimeForTest } from './claude.js';
import {
  ADMIN_FALLBACK_BUSY,
  type ClaudeRequest,
  type ClaudeRuntime,
  type ClaudeResponse,
} from '../lib/claude-runtime.js';
import { CUSTOMER_FALLBACK_BUSY, CUSTOMER_FALLBACK_TIMEOUT } from '../lib/agent-fallback.js';

const allowedGate = {
  allowed: true,
  hardBlock: false,
  softBudget: false,
  reason: null as string | null,
};

const baseReq: ClaudeRequest = {
  systemPrompt: 'You are a test agent.',
  conversationHistory: [{ role: 'user', content: 'привіт' }],
  userMessage: 'хочу манікюр',
};

function mockRuntime(completeImpl: () => Promise<ClaudeResponse>): ClaudeRuntime {
  const complete = vi.fn(completeImpl);
  return {
    kind: 'cli',
    complete,
    stream: complete,
    warmup: complete,
  };
}

function runtimeFromComplete(
  complete: ClaudeRuntime['complete'],
  kind: ClaudeRuntime['kind'] = 'cli',
): ClaudeRuntime {
  return { kind, complete, stream: complete, warmup: complete };
}

describe('askClaude runtime facade', () => {
  beforeEach(() => {
    queueState.pending = 0;
    evaluateClaudeSpawn.mockReset();
    evaluateClaudeSpawn.mockReturnValue(allowedGate);
    setClaudeRuntimeForTest(undefined);
  });

  afterEach(() => {
    setClaudeRuntimeForTest(undefined);
  });

  it('does not invoke the runtime when the quota circuit is hard-blocked', async () => {
    evaluateClaudeSpawn.mockReturnValue({
      allowed: false,
      hardBlock: true,
      softBudget: false,
      reason: 'session_exhausted',
    });
    const runtime = mockRuntime(async () => ({ text: 'should not run' }));
    setClaudeRuntimeForTest(runtime);

    const response = await askClaude(baseReq, { channel: 'instagram' });

    expect(runtime.complete).not.toHaveBeenCalled();
    expect(response.fallback).toBe('timeout');
    expect(response.errorDetail).toContain('quota_circuit_open');
    expect(response.text).toBe(CUSTOMER_FALLBACK_TIMEOUT);
    expect(response.resumed).toBe(false);
  });

  it('returns busy fallback when the semaphore queue is overloaded', async () => {
    queueState.pending = 11;
    const runtime = mockRuntime(async () => ({ text: 'should not run' }));
    setClaudeRuntimeForTest(runtime);

    const customer = await askClaude(baseReq, { channel: 'instagram' });
    expect(runtime.complete).not.toHaveBeenCalled();
    expect(customer.fallback).toBe('busy');
    expect(customer.text).toBe(CUSTOMER_FALLBACK_BUSY);

    const admin = await askClaude(baseReq, { channel: 'sandbox' });
    expect(admin.text).toBe(ADMIN_FALLBACK_BUSY);
  });

  it('passes through sessionId and marks resumed on a successful follow-up', async () => {
    const runtime = mockRuntime(async () => ({
      text: 'Слот вільний о 10:00.',
      sessionId: 'sess-reply-1',
    }));
    setClaudeRuntimeForTest(runtime);

    const response = await askClaude(
      { ...baseReq, resumeSessionId: 'sess-reply-1', userMessage: 'tool result' },
      { channel: 'instagram', model: 'sonnet' },
    );

    expect(runtime.complete).toHaveBeenCalledTimes(1);
    expect(runtime.complete).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'sess-reply-1' }),
      expect.objectContaining({ model: 'sonnet' }),
    );
    expect(response.sessionId).toBe('sess-reply-1');
    expect(response.resumed).toBe(true);
    expect(response.fallback).toBeUndefined();
    expect(response.text).toContain('Слот вільний');
  });

  it('retries cold (no resume) when resume fails for a non-rate-limit reason', async () => {
    const complete = vi
      .fn<ClaudeRuntime['complete']>()
      .mockResolvedValueOnce({
        text: CUSTOMER_FALLBACK_TIMEOUT,
        fallback: 'timeout',
        errorDetail: 'resume session missing',
      })
      .mockResolvedValueOnce({
        text: 'Ок, записала на завтра.',
        sessionId: 'sess-cold',
      });
    setClaudeRuntimeForTest(runtimeFromComplete(complete));

    const response = await askClaude(
      { ...baseReq, resumeSessionId: 'dead-session' },
      { channel: 'instagram' },
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0].resumeSessionId).toBe('dead-session');
    expect(complete.mock.calls[1][0].resumeSessionId).toBeUndefined();
    expect(response.resumed).toBe(false);
    expect(response.sessionId).toBe('sess-cold');
    expect(response.text).toContain('Ок, записала');
  });

  it('does not cold-retry when resume hits a rate-limit signal', async () => {
    const complete = vi.fn<ClaudeRuntime['complete']>().mockResolvedValue({
      text: CUSTOMER_FALLBACK_TIMEOUT,
      fallback: 'timeout',
      errorDetail: 'rate_limit: 429',
    });
    setClaudeRuntimeForTest(runtimeFromComplete(complete));

    const response = await askClaude(
      { ...baseReq, resumeSessionId: 'sess-rl' },
      { channel: 'instagram' },
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(response.fallback).toBe('timeout');
    expect(response.resumed).toBe(false);
  });

  it('merges text <tool_call> protocol after the runtime returns', async () => {
    setClaudeRuntimeForTest(
      mockRuntime(async () => ({
        text: `Шукаю вікна.

<tool_call>
{"name":"get_available_slots","args":{"date":"21.08.2026"}}
</tool_call>`,
        sessionId: 's1',
      })),
    );

    const response = await askClaude(baseReq, { channel: 'instagram' });
    expect(response.toolCalls).toEqual([
      { name: 'get_available_slots', args: { date: '21.08.2026' } },
    ]);
    expect(response.text).not.toContain('<tool_call>');
    expect(response.text).toContain('Шукаю вікна');
  });

  it('uses an injected SDK runtime — never a silent CLI success', async () => {
    const complete = vi.fn(async () => ({ text: 'sdk-direct', sessionId: 'sdk-1' }));
    setClaudeRuntimeForTest(runtimeFromComplete(complete, 'sdk'));
    const response = await askClaude(baseReq, { channel: 'instagram' });
    expect(response.text).toBe('sdk-direct');
    expect(response.sessionId).toBe('sdk-1');
    expect(complete).toHaveBeenCalled();
  });

  it('askClaudeStream forwards deltas and still finalizes tool calls', async () => {
    const deltas: string[] = [];
    const complete = vi.fn<ClaudeRuntime['complete']>(async (_req, opts) => {
      opts.onDelta?.('Привіт');
      return {
        text: `Привіт.

<tool_call>
{"name":"update_client_info","args":{"phone":"099"}}
</tool_call>`,
      };
    });
    setClaudeRuntimeForTest(runtimeFromComplete(complete));

    const response = await askClaudeStream(
      baseReq,
      (event) => {
        if (event.type === 'delta') deltas.push(event.text);
      },
      { channel: 'meta_agent' },
    );

    expect(deltas).toEqual(['Привіт']);
    expect(response.toolCalls?.[0]?.name).toBe('update_client_info');
    expect(response.text).not.toContain('<tool_call>');
  });

  it('forwards context.signal to the runtime invoke options', async () => {
    const ac = new AbortController();
    const runtime = mockRuntime(async () => ({ text: 'ok' }));
    setClaudeRuntimeForTest(runtime);
    await askClaude(baseReq, { channel: 'instagram', signal: ac.signal });
    expect(runtime.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: ac.signal }),
    );
  });
});
