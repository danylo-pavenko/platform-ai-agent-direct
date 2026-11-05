/**
 * Compact salon calendar for booking agents — weekday words («понеділок»)
 * must map to a concrete DD.MM.YYYY from this list, not model arithmetic.
 */

import {
  formatZonedSessionClock,
  getZonedDateTimeParts,
  zonedWallTimeToUtcMs,
} from './tenant-timezone.js';

/** JS Date#getDay index → Ukrainian weekday (lowercase, nominative). */
export const WEEKDAY_NAMES_UK = [
  'неділя',
  'понеділок',
  'вівторок',
  'середа',
  'четвер',
  "п'ятниця",
  'субота',
] as const;

export type UpcomingCalendarDay = {
  uaDate: string;
  isoDate: string;
  weekdayUk: string;
  weekday: number;
  isToday: boolean;
};

/** Advance one civil day from a noon wall-clock (DST-safe). */
function nextCivilDay(
  y: number,
  m: number,
  d: number,
  timeZone: string,
): { year: number; month: number; day: number } {
  const noonMs = zonedWallTimeToUtcMs({
    year: y,
    month: m,
    day: d,
    hour: 12,
    minute: 0,
    second: 0,
    timeZone,
  });
  // +24h from noon stays on the next civil day across spring/fall DST.
  const next = getZonedDateTimeParts(new Date(noonMs + 24 * 60 * 60 * 1000), timeZone);
  return { year: next.year, month: next.month, day: next.day };
}

/** Next `dayCount` civil days starting today in the tenant zone. */
export function listUpcomingCalendarDays(
  now: Date,
  timeZone: string,
  dayCount = 14,
): UpcomingCalendarDay[] {
  const start = getZonedDateTimeParts(now, timeZone);
  const out: UpcomingCalendarDay[] = [];
  let y = start.year;
  let m = start.month;
  let d = start.day;
  for (let i = 0; i < dayCount; i++) {
    const ms = zonedWallTimeToUtcMs({
      year: y,
      month: m,
      day: d,
      hour: 12,
      minute: 0,
      second: 0,
      timeZone,
    });
    const clock = formatZonedSessionClock(new Date(ms), timeZone);
    out.push({
      uaDate: clock.uaDate,
      isoDate: clock.isoDate,
      weekdayUk: WEEKDAY_NAMES_UK[clock.weekday] ?? '',
      weekday: clock.weekday,
      isToday: i === 0,
    });
    const next = nextCivilDay(y, m, d, timeZone);
    y = next.year;
    m = next.month;
    d = next.day;
  }
  return out;
}

/** Prompt block: agent must resolve «понеділок» / «завтра» only from this list. */
export function formatUpcomingCalendarPromptBlock(
  now: Date,
  timeZone: string,
  dayCount = 14,
): string {
  const days = listUpcomingCalendarDays(now, timeZone, dayCount);
  const lines = days.map((day) => {
    const tag = day.isToday ? ' ← сьогодні' : '';
    return `- ${day.uaDate} ${day.weekdayUk}${tag}`;
  });
  return [
    'Календар найближчих днів (час салону) — для «сьогодні»/«завтра»/«понеділок» бери дату ТІЛЬКИ звідси:',
    ...lines,
    'Заборонено вигадувати дату під день тижня. У тексті клієнту weekday і число мають збігатися з цим списком (напр. понеділок = дата з рядка «понеділок», не сусідній вівторок).',
  ].join('\n');
}

/**
 * Ukrainian weekday for a CRM/agent day key (YYYY-MM-DD or DD.MM.YYYY).
 * Returns empty string if unparseable.
 */
export function weekdayUkForDateKey(day: string, timeZone: string): string {
  const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(day.trim());
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(day.trim());
  let y: number;
  let m: number;
  let d: number;
  if (dmy) {
    d = Number(dmy[1]);
    m = Number(dmy[2]);
    y = Number(dmy[3]);
  } else if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    return '';
  }
  const ms = zonedWallTimeToUtcMs({
    year: y,
    month: m,
    day: d,
    hour: 12,
    minute: 0,
    second: 0,
    timeZone,
  });
  const wd = getZonedDateTimeParts(new Date(ms), timeZone).weekday;
  return WEEKDAY_NAMES_UK[wd] ?? '';
}
