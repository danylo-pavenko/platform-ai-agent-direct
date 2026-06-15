import { describe, expect, it } from 'vitest';
import {
  effectiveHandoffStartedAt,
  isHandoffIdleExpired,
} from './handoff-auto-return.js';

const base = {
  handedOffAt: new Date('2026-06-15T10:00:00Z'),
  lastMessageAt: new Date('2026-06-15T11:00:00Z'),
  createdAt: new Date('2026-06-15T09:00:00Z'),
};

describe('effectiveHandoffStartedAt', () => {
  it('prefers handedOffAt', () => {
    expect(effectiveHandoffStartedAt(base).toISOString()).toBe('2026-06-15T10:00:00.000Z');
  });

  it('falls back to lastMessageAt', () => {
    expect(
      effectiveHandoffStartedAt({ ...base, handedOffAt: null }).toISOString(),
    ).toBe('2026-06-15T11:00:00.000Z');
  });
});

describe('isHandoffIdleExpired', () => {
  it('expires after timeout minutes', () => {
    const now = new Date('2026-06-15T11:01:00Z').getTime();
    expect(isHandoffIdleExpired(base, 60, now)).toBe(true);
  });

  it('does not expire before timeout', () => {
    const now = new Date('2026-06-15T10:30:00Z').getTime();
    expect(isHandoffIdleExpired(base, 60, now)).toBe(false);
  });

  it('never expires when timeout is 0 (disabled)', () => {
    const now = new Date('2026-06-16T10:00:00Z').getTime();
    expect(isHandoffIdleExpired(base, 0, now)).toBe(false);
  });
});
