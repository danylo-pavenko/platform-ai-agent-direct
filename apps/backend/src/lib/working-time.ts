import {
  getZonedDateTimeParts,
  zonedWallTimeToUtcMs,
} from './tenant-timezone.js';

/** Same shape as prompt-builder `WorkingHours` (day keys: mon…sun). */
export type WorkingHoursLike = {
  [day: string]: { start: string; end: string; enabled: boolean } | undefined;
};

const JS_DAY_TO_KEY: Record<number, string> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

const MAX_ELAPSED_DAYS = 62;

function parseHmToMinutes(value: string): number | null {
  const [hRaw, mRaw] = value.split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 24 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function nextCivilDate(year: number, month: number, day: number): {
  year: number;
  month: number;
  day: number;
} {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/**
 * Working-time milliseconds between two instants in the tenant zone.
 * Closed days and off-hours do not count (matches `managerSlaHoursBusiness`).
 */
export function elapsedWorkingMs(
  from: Date,
  to: Date,
  hours: WorkingHoursLike,
  timeZone: string,
): number {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return 0;
  }

  const start = getZonedDateTimeParts(from, timeZone);
  const end = getZonedDateTimeParts(to, timeZone);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  let total = 0;

  for (let i = 0; i < MAX_ELAPSED_DAYS; i++) {
    const noonMs = zonedWallTimeToUtcMs({
      year,
      month,
      day,
      hour: 12,
      minute: 0,
      second: 0,
      timeZone,
    });
    const weekday = getZonedDateTimeParts(new Date(noonMs), timeZone).weekday;
    const dayKey = JS_DAY_TO_KEY[weekday];
    const dayConfig = dayKey ? hours[dayKey] : undefined;
    if (dayConfig?.enabled) {
      const startMin = parseHmToMinutes(dayConfig.start);
      const endMin = parseHmToMinutes(dayConfig.end);
      if (startMin != null && endMin != null && endMin > startMin) {
        const windowStart = zonedWallTimeToUtcMs({
          year,
          month,
          day,
          hour: Math.floor(startMin / 60),
          minute: startMin % 60,
          second: 0,
          timeZone,
        });
        const windowEnd = zonedWallTimeToUtcMs({
          year,
          month,
          day,
          hour: Math.floor(endMin / 60),
          minute: endMin % 60,
          second: 0,
          timeZone,
        });
        const lo = Math.max(fromMs, windowStart);
        const hi = Math.min(toMs, windowEnd);
        if (hi > lo) total += hi - lo;
      }
    }

    if (year === end.year && month === end.month && day === end.day) break;
    ({ year, month, day } = nextCivilDate(year, month, day));
  }

  return total;
}
