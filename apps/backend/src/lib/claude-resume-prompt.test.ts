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

import { buildClaudePromptForTest } from '../services/claude.js';

describe('buildClaudePromptForTest (resume slim)', () => {
  const baseReq = {
    systemPrompt: 'SYSTEM BIG PROMPT',
    conversationHistory: [
      { role: 'user' as const, content: 'хочу стрижку' },
      { role: 'assistant' as const, content: 'шукаю слоти' },
    ],
    userMessage: '[get_available_slots] РЕЗУЛЬТАТ:\n10:00',
    tools: [
      {
        name: 'get_available_slots',
        description: 'slots',
        parameters: {},
      },
    ],
  };

  it('includes system, history and tools on cold start', () => {
    const prompt = buildClaudePromptForTest(baseReq);
    expect(prompt).toContain('SYSTEM BIG PROMPT');
    expect(prompt).toContain('хочу стрижку');
    expect(prompt).toContain('get_available_slots');
    expect(prompt).toContain('[get_available_slots] РЕЗУЛЬТАТ');
  });

  it('sends only the new Human message on resume', () => {
    const prompt = buildClaudePromptForTest(baseReq, { resume: true });
    expect(prompt).toBe('Human: [get_available_slots] РЕЗУЛЬТАТ:\n10:00');
    expect(prompt).not.toContain('SYSTEM BIG PROMPT');
    expect(prompt).not.toContain('хочу стрижку');
  });
});
