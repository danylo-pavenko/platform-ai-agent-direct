import { describe, expect, it } from 'vitest';
import { elapsedWorkingMs, type WorkingHoursLike } from './working-time.js';

const WEEKDAYS: WorkingHoursLike = {
  mon: { start: '09:00', end: '18:00', enabled: true },
  tue: { start: '09:00', end: '18:00', enabled: true },
  wed: { start: '09:00', end: '18:00', enabled: true },
  thu: { start: '09:00', end: '18:00', enabled: true },
  fri: { start: '09:00', end: '18:00', enabled: true },
  sat: { start: '09:00', end: '18:00', enabled: false },
  sun: { start: '09:00', end: '18:00', enabled: false },
};

const TZ = 'Europe/Kyiv';

describe('elapsedWorkingMs', () => {
  it('counts same-day open hours', () => {
    const from = new Date('2026-09-21T07:00:00.000Z'); // Mon 10:00 Kyiv (UTC+3)
    const to = new Date('2026-09-21T09:00:00.000Z'); // Mon 12:00
    expect(elapsedWorkingMs(from, to, WEEKDAYS, TZ)).toBe(2 * 60 * 60 * 1000);
  });

  it('skips closed weekend', () => {
    const from = new Date('2026-09-18T14:00:00.000Z'); // Fri 17:00 Kyiv
    const to = new Date('2026-09-21T07:00:00.000Z'); // Mon 10:00
    expect(elapsedWorkingMs(from, to, WEEKDAYS, TZ)).toBe(2 * 60 * 60 * 1000);
  });

  it('ignores off-hours on an open day', () => {
    const from = new Date('2026-09-21T16:00:00.000Z'); // Mon 19:00
    const to = new Date('2026-09-21T20:00:00.000Z'); // Mon 23:00
    expect(elapsedWorkingMs(from, to, WEEKDAYS, TZ)).toBe(0);
  });
});
