import { describe, expect, it } from 'vitest';
import { shouldRunDailyCheck } from './claude-auth-monitor.js';
import { DEFAULT_CRM_SYNC_HOUR, syncCivilDayStartUtc } from './crm-sync-schedule.js';

describe('daily CRM sync schedule (tenant TZ)', () => {
  it('defaults to 04:00 salon hour', () => {
    expect(DEFAULT_CRM_SYNC_HOUR).toBe(4);
  });

  it('fires once after 04:00 Europe/Kyiv and not again the same day', () => {
    // 2026-06-26 01:00 UTC = 04:00 EEST Kyiv
    const atFour = new Date('2026-06-26T01:00:00.000Z');
    expect(shouldRunDailyCheck(atFour, 4, 'Europe/Kyiv', null)).toEqual({
      run: true,
      dateKey: '2026-06-26',
    });
    expect(shouldRunDailyCheck(atFour, 4, 'Europe/Kyiv', '2026-06-26').run).toBe(false);
  });

  it('does not run before 04:00', () => {
    const atThree = new Date('2026-06-26T00:00:00.000Z'); // 03:00 Kyiv
    expect(shouldRunDailyCheck(atThree, 4, 'Europe/Kyiv', null).run).toBe(false);
  });

  it('catches up later the same day if API was down at 04:00', () => {
    const atTwenty = new Date('2026-06-26T17:00:00.000Z'); // 20:00 Kyiv
    expect(shouldRunDailyCheck(atTwenty, 4, 'Europe/Kyiv', null).run).toBe(true);
  });

  it('maps civil-day start in Kyiv to the correct UTC instant (EEST)', () => {
    const noonUtc = new Date('2026-06-26T09:00:00.000Z'); // 12:00 Kyiv
    const start = syncCivilDayStartUtc('Europe/Kyiv', noonUtc);
    // Midnight Kyiv on 26 Jun 2026 (EEST, UTC+3) = 2026-06-25T21:00:00.000Z
    expect(start.toISOString()).toBe('2026-06-25T21:00:00.000Z');
  });
});
