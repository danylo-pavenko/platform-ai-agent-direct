import { describe, expect, it } from 'vitest';
import { computeExtendedExpiry, addCalendarMonths } from './tenant-access.js';

describe('tenant-access', () => {
  const now = new Date('2026-06-23T12:00:00Z');

  it('addCalendarMonths adds calendar months', () => {
    const from = new Date('2026-01-31T12:00:00Z');
    const result = addCalendarMonths(from, 1);
    expect(result.getMonth()).toBe(2);
  });

  it('extends from now when no current expiry', () => {
    const result = computeExtendedExpiry(null, 3, now);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(8); // June + 3 = September (0-indexed 8)
  });

  it('extends from future expiry when still active', () => {
    const current = new Date('2026-12-01T00:00:00Z');
    const result = computeExtendedExpiry(current, 1, now);
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0); // January
  });
});
