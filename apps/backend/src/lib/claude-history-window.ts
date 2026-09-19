import { MS_PER_DAY } from './session-freshness.js';
import { getZonedDateTimeParts, zonedWallTimeToUtcMs } from './tenant-timezone.js';

/**
 * Soft ceiling after the logical window (civil day / after last order).
 * Not a second “last 30” cut — only a guard against pathological threads.
 */
export const CLAUDE_HISTORY_SAFETY_CAP = 80;
/** Fetch extra rows so empty/media-only lines do not starve the cap. */
export const CLAUDE_HISTORY_FETCH_CAP = 120;

export type ClaudeHistoryWindowReason = 'civil_day' | 'conversation_start' | 'after_order';

export type ClaudeHistoryWindow = {
  from: Date;
  /** false → Prisma `gt` (messages after a completed order/visit). */
  inclusive: boolean;
  reason: ClaudeHistoryWindowReason;
};

export function startOfTenantCivilDay(now: Date, timeZone: string): Date {
  const z = getZonedDateTimeParts(now, timeZone);
  const ms = zonedWallTimeToUtcMs({
    year: z.year,
    month: z.month,
    day: z.day,
    hour: 0,
    minute: 0,
    second: 0,
    timeZone,
  });
  return new Date(ms);
}

/**
 * Whole salon calendar days between two instants (tenant IANA zone).
 * Yesterday 23:00 → today 09:00 is 1, not 0 (unlike a rolling 24h floor).
 */
export function civilSessionGapDays(from: Date, to: Date, timeZone: string): number {
  const start = startOfTenantCivilDay(from, timeZone).getTime();
  const end = startOfTenantCivilDay(to, timeZone).getTime();
  if (end <= start) return 0;
  return Math.round((end - start) / MS_PER_DAY);
}

export function isTimestampInHistoryWindow(at: Date, window: ClaudeHistoryWindow): boolean {
  return window.inclusive
    ? at.getTime() >= window.from.getTime()
    : at.getTime() > window.from.getTime();
}

/**
 * Greeting / no-re-greet scope: this tenant civil day (or conversation start
 * if the UUID began today). Completed orders do not reset greeting — that
 * stays inside the same-day checkout. Cycle markers are ignored on purpose.
 */
export function resolveGreetingScopeWindow(params: {
  now: Date;
  timeZone: string;
  conversationCreatedAt: Date;
}): ClaudeHistoryWindow {
  return resolveClaudeHistoryWindow({
    now: params.now,
    timeZone: params.timeZone,
    conversationCreatedAt: params.conversationCreatedAt,
    cycleMarkers: [],
  });
}

/**
 * Claude history for this turn: tenant civil day of the current conversation,
 * or from the previous completed order/visit if several happened today.
 */
export function resolveClaudeHistoryWindow(params: {
  now: Date;
  timeZone: string;
  conversationCreatedAt: Date;
  cycleMarkers: Array<{ at: Date }>;
}): ClaudeHistoryWindow {
  const dayStart = startOfTenantCivilDay(params.now, params.timeZone);
  const convoStart = params.conversationCreatedAt;
  const floor = convoStart.getTime() > dayStart.getTime() ? convoStart : dayStart;
  const floorReason: ClaudeHistoryWindowReason =
    convoStart.getTime() > dayStart.getTime() ? 'conversation_start' : 'civil_day';

  let latestToday: Date | null = null;
  for (const marker of params.cycleMarkers) {
    const t = marker.at.getTime();
    if (Number.isNaN(t)) continue;
    if (t < dayStart.getTime()) continue;
    if (t > params.now.getTime()) continue;
    if (!latestToday || t > latestToday.getTime()) latestToday = marker.at;
  }

  if (latestToday && latestToday.getTime() >= floor.getTime()) {
    return { from: latestToday, inclusive: false, reason: 'after_order' };
  }

  return { from: floor, inclusive: true, reason: floorReason };
}
