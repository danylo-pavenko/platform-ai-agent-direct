import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    CLAUDE_MODEL: 'sonnet',
  },
}));

vi.mock('./prisma.js', () => ({ prisma: {} }));

import {
  normalizeClaudeModel,
  normalizeClaudeReplyModel,
  normalizeFallbackMessages,
  normalizeRespondAdsOnly,
  normalizeResponseDelayBounds,
  resolveResponseDelayMs,
  DEFAULT_FALLBACK_MESSAGES,
  RESPONSE_DELAY_SEC_MAX,
} from './agent-config.js';
import { DEFAULT_TENANT_TIMEZONE, normalizeTenantTimezone } from './tenant-timezone.js';

describe('agent-config normals', () => {
  it('clamps response delay and resolves ms', () => {
    expect(normalizeResponseDelayBounds(undefined, undefined)).toEqual({ min: 0, max: 0 });
    expect(normalizeResponseDelayBounds(-1, 100)).toEqual({
      min: 0,
      max: RESPONSE_DELAY_SEC_MAX,
    });
    expect(normalizeResponseDelayBounds(10, 5)).toEqual({ min: 10, max: 10 });
    expect(
      resolveResponseDelayMs({ responseDelayMinSeconds: 0, responseDelayMaxSeconds: 0 }),
    ).toBe(0);
    expect(
      resolveResponseDelayMs({ responseDelayMinSeconds: 5, responseDelayMaxSeconds: 5 }),
    ).toBe(5000);
    expect(
      resolveResponseDelayMs(
        { responseDelayMinSeconds: 2, responseDelayMaxSeconds: 4 },
        () => 0.5,
      ),
    ).toBe(3000);
  });

  it('normalizes reply model (sonnet|opus only) and timezone', () => {
    expect(normalizeClaudeModel('haiku')).toBe('haiku');
    expect(normalizeClaudeModel('invalid')).toBe('sonnet');
    expect(normalizeClaudeReplyModel('opus')).toBe('opus');
    expect(normalizeClaudeReplyModel('haiku')).toBe('sonnet');
    expect(normalizeTenantTimezone(undefined)).toBe(DEFAULT_TENANT_TIMEZONE);
    expect(normalizeTenantTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
  });

  it('fills fallback messages and opt-in respondAdsOnly', () => {
    const normalized = normalizeFallbackMessages({
      timeout: { uk: 'Custom UK', en: '' },
      busy: {},
    });
    expect(normalized.timeout.uk).toBe('Custom UK');
    expect(normalized.timeout.en).toBe(DEFAULT_FALLBACK_MESSAGES.timeout.en);
    expect(normalizeRespondAdsOnly(undefined)).toBe(false);
    expect(normalizeRespondAdsOnly(true)).toBe(true);
    expect(normalizeRespondAdsOnly('true')).toBe(true);
    expect(normalizeRespondAdsOnly(false)).toBe(false);
  });
});
