import { describe, expect, it } from 'vitest';
import {
  formatUpcomingCalendarPromptBlock,
  listUpcomingCalendarDays,
  weekdayUkForDateKey,
} from './booking-weekday-calendar.js';

describe('listUpcomingCalendarDays', () => {
  it('maps Wed 4 Nov 2026 → next Monday 09.11, Tuesday 10.11', () => {
    // 2026-11-04 19:44 Europe/Kyiv = 17:44 UTC
    const now = new Date('2026-11-04T17:44:00.000Z');
    const days = listUpcomingCalendarDays(now, 'Europe/Kyiv', 8);
    expect(days[0]).toMatchObject({
      uaDate: '04.11.2026',
      weekdayUk: 'середа',
      isToday: true,
    });
    const monday = days.find((d) => d.weekdayUk === 'понеділок');
    const tuesday = days.find((d) => d.weekdayUk === 'вівторок');
    expect(monday?.uaDate).toBe('09.11.2026');
    expect(tuesday?.uaDate).toBe('10.11.2026');
  });
});

describe('formatUpcomingCalendarPromptBlock', () => {
  it('includes today marker and forbids inventing weekday dates', () => {
    const now = new Date('2026-11-04T17:44:00.000Z');
    const block = formatUpcomingCalendarPromptBlock(now, 'Europe/Kyiv', 7);
    expect(block).toContain('04.11.2026 середа ← сьогодні');
    expect(block).toContain('09.11.2026 понеділок');
    expect(block).toContain('10.11.2026 вівторок');
    expect(block).toMatch(/бери дату ТІЛЬКИ звідси/);
  });
});

describe('weekdayUkForDateKey', () => {
  it('labels ISO and UA dates in Kyiv', () => {
    expect(weekdayUkForDateKey('2026-11-09', 'Europe/Kyiv')).toBe('понеділок');
    expect(weekdayUkForDateKey('10.11.2026', 'Europe/Kyiv')).toBe('вівторок');
    expect(weekdayUkForDateKey('garbage', 'Europe/Kyiv')).toBe('');
  });
});
