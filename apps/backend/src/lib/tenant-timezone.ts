/**
 * Tenant business timezone (IANA). Server may run in DE; salon calendar is local.
 * Default: Europe/Kyiv.
 */

export const DEFAULT_TENANT_TIMEZONE = 'Europe/Kyiv';

export type TenantTimezoneOption = {
  id: string;
  label: string;
};

/** Curated list for admin dropdown (common salon markets). */
export const TENANT_TIMEZONE_OPTIONS: readonly TenantTimezoneOption[] = [
  { id: 'Europe/Kyiv', label: 'Україна — Київ' },
  { id: 'Europe/Berlin', label: 'Німеччина — Берлін' },
  { id: 'Europe/Warsaw', label: 'Польща — Варшава' },
  { id: 'Europe/Bucharest', label: 'Румунія — Бухарест' },
  { id: 'Europe/Chisinau', label: 'Молдова — Кишинів' },
  { id: 'Europe/Prague', label: 'Чехія — Прага' },
  { id: 'Europe/Vienna', label: 'Австрія — Відень' },
  { id: 'Europe/Amsterdam', label: 'Нідерланди — Амстердам' },
  { id: 'Europe/Paris', label: 'Франція — Париж' },
  { id: 'Europe/London', label: 'Велика Британія — Лондон' },
  { id: 'Europe/Zurich', label: 'Швейцарія — Цюрих' },
  { id: 'UTC', label: 'UTC' },
] as const;

const WEEKDAY_TO_JS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidIanaTimeZone(id: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: id }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Alias used by older tzdata. */
export function canonicalizeTimeZoneId(raw: string): string {
  const t = raw.trim();
  if (t === 'Europe/Kiev') return 'Europe/Kyiv';
  return t;
}

export function normalizeTenantTimezone(
  value: unknown,
  fallback: string = DEFAULT_TENANT_TIMEZONE,
): string {
  if (typeof value !== 'string') {
    return isValidIanaTimeZone(fallback) ? fallback : DEFAULT_TENANT_TIMEZONE;
  }
  const id = canonicalizeTimeZoneId(value);
  if (!id || !isValidIanaTimeZone(id)) {
    return isValidIanaTimeZone(fallback) ? fallback : DEFAULT_TENANT_TIMEZONE;
  }
  return id;
}

export type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Same as Date#getDay: 0 = Sunday. */
  weekday: number;
  timeZone: string;
};

export function getZonedDateTimeParts(
  date: Date,
  timeZone: string,
): ZonedDateTimeParts {
  const tz = normalizeTenantTimezone(timeZone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const weekday = WEEKDAY_TO_JS[map.weekday ?? ''] ?? 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
    timeZone: tz,
  };
}

/** Wall-clock in IANA zone → UTC epoch ms. */
export function zonedWallTimeToUtcMs(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  timeZone: string;
}): number {
  const { year, month, day, hour, minute, timeZone } = parts;
  const second = parts.second ?? 0;
  const tz = normalizeTenantTimezone(timeZone);
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const z = getZonedDateTimeParts(new Date(utc), tz);
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = target - asUtc;
    utc += diff;
    if (diff === 0) break;
  }
  return utc;
}

export function formatZonedSessionClock(
  date: Date,
  timeZone: string,
): {
  isoDate: string;
  uaDate: string;
  clock: string;
  dateTime: string;
  weekday: number;
  timeZone: string;
} {
  const z = getZonedDateTimeParts(date, timeZone);
  const isoDate = `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
  const uaDate = `${String(z.day).padStart(2, '0')}.${String(z.month).padStart(2, '0')}.${z.year}`;
  const clock = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
  return {
    isoDate,
    uaDate,
    clock,
    dateTime: `${uaDate} ${clock}`,
    weekday: z.weekday,
    timeZone: z.timeZone,
  };
}

/**
 * Inclusive civil-day window in the tenant zone, as ISO-8601 UTC for CRM APIs.
 */
export function civilDayBoundsUtcIso(
  parts: { y: number; m: number; d: number },
  timeZone: string,
  fullMonth = false,
): { from: string; to: string } {
  const tz = normalizeTenantTimezone(timeZone);
  if (fullMonth) {
    const fromMs = zonedWallTimeToUtcMs({
      year: parts.y,
      month: parts.m,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      timeZone: tz,
    });
    const lastDay = new Date(Date.UTC(parts.y, parts.m, 0)).getUTCDate();
    const toMs = zonedWallTimeToUtcMs({
      year: parts.y,
      month: parts.m,
      day: lastDay,
      hour: 23,
      minute: 59,
      second: 59,
      timeZone: tz,
    });
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  }

  const fromMs = zonedWallTimeToUtcMs({
    year: parts.y,
    month: parts.m,
    day: parts.d,
    hour: 0,
    minute: 0,
    second: 0,
    timeZone: tz,
  });
  const toMs = zonedWallTimeToUtcMs({
    year: parts.y,
    month: parts.m,
    day: parts.d,
    hour: 23,
    minute: 59,
    second: 59,
    timeZone: tz,
  });
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}
