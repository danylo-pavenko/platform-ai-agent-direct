import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    CLAUDE_MODEL: 'sonnet',
    CLAUDE_MAX_CONCURRENCY: 2,
    CLAUDE_META_MAX_CONCURRENCY: 1,
    CLAUDE_TIMEOUT_MS: 120_000,
    CLAUDE_ADMIN_TIMEOUT_MS: 120_000,
    INSTANCE_ID: 'test',
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/queue.js', () => ({
  Semaphore: class {
    pending = 0;
    active = 0;
    async acquire() {
      return () => undefined;
    }
  },
}));
vi.mock('../lib/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-config.js')>();
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

import { buildClaudeCliArgsForTest } from '../services/claude.js';

describe('buildClaudeCliArgsForTest', () => {
  it('uses sonnet by default from config', () => {
    const args = buildClaudeCliArgsForTest(false);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('overrides model when provided', () => {
    const args = buildClaudeCliArgsForTest(false, 'haiku');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
  });

  it('normalizes invalid model to env fallback', () => {
    const args = buildClaudeCliArgsForTest(false, 'not-a-model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });
});
