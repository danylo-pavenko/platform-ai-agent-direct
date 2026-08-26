import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_TIMEZONE,
  civilDayBoundsUtcIso,
  formatZonedSessionClock,
  getZonedDateTimeParts,
  normalizeTenantTimezone,
} from './tenant-timezone.js';

describe('normalizeTenantTimezone', () => {
  it('defaults to Kyiv', () => {
    expect(normalizeTenantTimezone(undefined)).toBe(DEFAULT_TENANT_TIMEZONE);
    expect(normalizeTenantTimezone('')).toBe('Europe/Kyiv');
    expect(normalizeTenantTimezone('Not/AZone')).toBe('Europe/Kyiv');
  });

  it('maps Europe/Kiev and accepts IANA ids', () => {
    expect(normalizeTenantTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(normalizeTenantTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(normalizeTenantTimezone(' UTC ')).toBe('UTC');
  });
});

describe('zoned civil clock', () => {
  it('reads Kyiv wall time from a UTC instant (EEST)', () => {
    // 2026-08-26 12:00 UTC = 15:00 Europe/Kyiv
    const at = new Date('2026-08-26T12:00:00.000Z');
    const kyiv = getZonedDateTimeParts(at, 'Europe/Kyiv');
    expect(kyiv.hour).toBe(15);
    expect(kyiv.day).toBe(26);
    expect(kyiv.weekday).toBe(3); // Wednesday

    const berlin = getZonedDateTimeParts(at, 'Europe/Berlin');
    expect(berlin.hour).toBe(14);
  });

  it('formats session clock in UA date', () => {
    const clock = formatZonedSessionClock(new Date('2026-08-26T12:00:00.000Z'), 'Europe/Kyiv');
    expect(clock.uaDate).toBe('26.08.2026');
    expect(clock.clock).toBe('15:00');
    expect(clock.dateTime).toBe('26.08.2026 15:00');
    expect(clock.timeZone).toBe('Europe/Kyiv');
  });

  it('builds CRM day bounds in Kyiv, not UTC midnight', () => {
    const bounds = civilDayBoundsUtcIso({ y: 2026, m: 8, d: 5 }, 'Europe/Kyiv');
    // EEST UTC+3 → 00:00 Kyiv = 21:00 previous day UTC
    expect(bounds.from).toBe('2026-08-04T21:00:00.000Z');
    expect(bounds.to).toBe('2026-08-05T20:59:59.000Z');
  });

  it('UTC bounds stay on the civil date', () => {
    const bounds = civilDayBoundsUtcIso({ y: 2026, m: 8, d: 5 }, 'UTC');
    expect(bounds.from).toBe('2026-08-05T00:00:00.000Z');
    expect(bounds.to).toBe('2026-08-05T23:59:59.000Z');
  });
});
