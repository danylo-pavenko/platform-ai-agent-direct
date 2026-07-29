import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    CLAUDE_MODEL: 'sonnet',
  },
}));

vi.mock('./prisma.js', () => ({ prisma: {} }));

import {
  normalizeClaudeModel,
  normalizeResponseDelayBounds,
  resolveResponseDelayMs,
  RESPONSE_DELAY_SEC_MAX,
} from './agent-config.js';

describe('normalizeResponseDelayBounds', () => {
  it('defaults to 0/0', () => {
    expect(normalizeResponseDelayBounds(undefined, undefined)).toEqual({ min: 0, max: 0 });
  });

  it('clamps to 0..60 and lifts max to min', () => {
    expect(normalizeResponseDelayBounds(-1, 100)).toEqual({
      min: 0,
      max: RESPONSE_DELAY_SEC_MAX,
    });
    expect(normalizeResponseDelayBounds(10, 5)).toEqual({ min: 10, max: 10 });
  });
});

describe('normalizeClaudeModel', () => {
  it('accepts haiku, sonnet, opus', () => {
    expect(normalizeClaudeModel('haiku')).toBe('haiku');
    expect(normalizeClaudeModel('sonnet')).toBe('sonnet');
    expect(normalizeClaudeModel('opus')).toBe('opus');
  });

  it('falls back for unknown values', () => {
    expect(normalizeClaudeModel('gpt-4', 'haiku')).toBe('haiku');
    expect(normalizeClaudeModel(undefined, 'opus')).toBe('opus');
    expect(normalizeClaudeModel(null, 'sonnet')).toBe('sonnet');
  });

  it('uses CLAUDE_MODEL env when fallback omitted', () => {
    expect(normalizeClaudeModel('invalid')).toBe('sonnet');
  });
});

describe('resolveResponseDelayMs', () => {
  it('returns 0 when max is 0', () => {
    expect(
      resolveResponseDelayMs({ responseDelayMinSeconds: 0, responseDelayMaxSeconds: 0 }),
    ).toBe(0);
  });

  it('returns fixed ms when min equals max', () => {
    expect(
      resolveResponseDelayMs({ responseDelayMinSeconds: 5, responseDelayMaxSeconds: 5 }),
    ).toBe(5000);
  });

  it('picks within range using random', () => {
    const ms = resolveResponseDelayMs(
      { responseDelayMinSeconds: 2, responseDelayMaxSeconds: 4 },
      () => 0.5,
    );
    expect(ms).toBe(3000);
  });
});
