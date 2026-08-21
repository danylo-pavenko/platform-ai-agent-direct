/**
 * Claude subscription quota circuit — single policy for all CLI spawns.
 *
 * Layers:
 * 1. Hard block until `blockedUntilMs` (from 429 reset text or usage bucket ISO).
 * 2. Soft budget — background jobs stop before session hits 100%.
 * 3. Purpose matrix — probes / retries / usage never bypass the gate.
 *
 * In-memory state is hydrated from DB on boot (`services/claude-quota.ts`).
 */

import { isClaudeRateLimitSignal } from './claude-auth-probe.js';

/** Minimal usage snapshot shape for gate decisions (avoids service→lib cycles). */
export interface ClaudeUsageExhaustedHint {
  status: string;
  checkedAt: string;
  buckets?: Array<{
    id: string;
    label: string;
    percentUsed: number;
    resetsAt: string;
    /** Raw ISO from Claude Code cache when available. */
    resetsAtIso?: string | null;
  }>;
  worstPercent?: number;
}

export type ClaudeSpawnPurpose =
  | 'customer_dm'
  | 'admin'
  | 'usage_refresh'
  | 'auth_probe'
  | 'warmup'
  | 'latency_probe'
  | 'conversation_retry'
  | 'follow_up'
  | 'unspecified';

/** Fallback when 429 has no parseable reset (session windows are ~5h). */
export const CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS = 5 * 60 * 60 * 1000;

/** Soft stop for background work before hard 100%. */
export const CLAUDE_QUOTA_SOFT_PERCENT_DEFAULT = 90;

/**
 * @deprecated Prefer circuit blockedUntil / session resetsAt.
 * Kept for tests that assert age-based skip; live path uses evaluateClaudeSpawn.
 */
export const CLAUDE_USAGE_EXHAUSTED_SKIP_LIVE_MS = 25 * 60 * 1000;

export interface ClaudeQuotaMemoryState {
  blockedUntilMs: number;
  reason: string | null;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetsAtIso: string | null;
  /** session | weekly | unknown — drives admin copy */
  limitKind: 'session' | 'weekly' | 'unknown' | null;
  updatedAtMs: number;
}

export interface ClaudeSpawnDecision {
  allowed: boolean;
  reason: string | null;
  softBudget: boolean;
  hardBlock: boolean;
}

const BACKGROUND_PURPOSES = new Set<ClaudeSpawnPurpose>([
  'usage_refresh',
  'auth_probe',
  'warmup',
  'latency_probe',
  'conversation_retry',
  'follow_up',
]);

let state: ClaudeQuotaMemoryState = emptyState();

function emptyState(): ClaudeQuotaMemoryState {
  return {
    blockedUntilMs: 0,
    reason: null,
    sessionPercent: null,
    weeklyPercent: null,
    sessionResetsAtIso: null,
    limitKind: null,
    updatedAtMs: 0,
  };
}

export function getClaudeQuotaMemoryState(): Readonly<ClaudeQuotaMemoryState> {
  return state;
}

export function hydrateClaudeQuotaMemory(next: Partial<ClaudeQuotaMemoryState>): void {
  state = {
    ...state,
    ...next,
    updatedAtMs: next.updatedAtMs ?? Date.now(),
  };
}

function getZonedParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  // Some engines emit 24:00 for midnight
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
  };
}

/**
 * Convert a wall-clock local time in an IANA zone to UTC epoch ms.
 */
export function zonedWallTimeToUtcMs(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): number {
  const { year, month, day, hour, minute, timeZone } = parts;
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const z = getZonedParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, 0);
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = target - asUtc;
    utc += diff;
    if (diff === 0) break;
  }
  return utc;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Parse Claude reset hints:
 * - ISO timestamps
 * - `resets 7:40pm (Europe/Berlin)`
 * - `resets 6pm (Europe/Berlin)` (hour + am/pm, no minutes)
 * - `resets Aug 16, 6pm (Europe/Berlin)` / `Aug 14, 2:40pm (Europe/Berlin)`
 */
export function parseClaudeResetToMs(
  text: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!text?.trim()) return null;
  const raw = text.trim();

  const isoTry = Date.parse(raw);
  if (Number.isFinite(isoTry) && /\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return isoTry;
  }

  const zoneMatch = raw.match(/\(([^)]+\/[^)]+)\)\s*$/);
  const timeZone = zoneMatch?.[1]?.trim() || 'UTC';

  // Date prefix optional: Aug 16, 2026 | Aug 16,
  const datePrefix =
    /(?:resets?\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?[, ]+)?/i;

  // 2:40pm / 14:40 / 2:40
  const withMinutes = new RegExp(
    `${datePrefix.source}(\\d{1,2}):(\\d{2})\\s*(am|pm)?`,
    'i',
  );
  // 6pm / 6 am (Claude weekly messages often omit :00)
  const hourOnly = new RegExp(
    `${datePrefix.source}(\\d{1,2})\\s*(am|pm)\\b`,
    'i',
  );

  let monthName: string | undefined;
  let dayNum: number | null = null;
  let yearNum: number | null = null;
  let hour: number;
  let minute: number;
  let ampm: string | undefined;

  const mMin = raw.match(withMinutes);
  if (mMin) {
    monthName = mMin[1];
    dayNum = mMin[2] ? Number(mMin[2]) : null;
    yearNum = mMin[3] ? Number(mMin[3]) : null;
    hour = Number(mMin[4]);
    minute = Number(mMin[5]);
    ampm = mMin[6]?.toLowerCase();
  } else {
    const mHour = raw.match(hourOnly);
    if (!mHour) return null;
    monthName = mHour[1];
    dayNum = mHour[2] ? Number(mHour[2]) : null;
    yearNum = mHour[3] ? Number(mHour[3]) : null;
    hour = Number(mHour[4]);
    minute = 0;
    ampm = mHour[5]?.toLowerCase();
  }

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const nowParts = getZonedParts(new Date(nowMs), timeZone);
  const year = yearNum ?? nowParts.year;
  const month = monthName ? MONTHS[monthName.toLowerCase()] : nowParts.month;
  const day = dayNum ?? nowParts.day;
  if (!month) return null;

  let ms = zonedWallTimeToUtcMs({ year, month, day, hour, minute, timeZone });
  // Clock-only "resets 2pm" that already passed today → tomorrow
  if (!monthName && !dayNum && ms <= nowMs) {
    const tomorrow = new Date(ms + 24 * 60 * 60 * 1000);
    const tp = getZonedParts(tomorrow, timeZone);
    ms = zonedWallTimeToUtcMs({
      year: tp.year,
      month: tp.month,
      day: tp.day,
      hour,
      minute,
      timeZone,
    });
  }
  // Dated reset already in the past (wrong year) → try next year
  if (monthName && dayNum && ms <= nowMs && yearNum == null) {
    ms = zonedWallTimeToUtcMs({
      year: year + 1,
      month,
      day,
      hour,
      minute,
      timeZone,
    });
  }
  if (ms <= nowMs) return null;
  return ms;
}

export function sessionBucketFromHint(
  snap: ClaudeUsageExhaustedHint | null | undefined,
): NonNullable<ClaudeUsageExhaustedHint['buckets']>[number] | null {
  const buckets = snap?.buckets;
  if (!buckets?.length) return null;
  return buckets.find((b) => /session/i.test(b.id) || /session/i.test(b.label)) ?? null;
}

export function weekBucketFromHint(
  snap: ClaudeUsageExhaustedHint | null | undefined,
): { percentUsed: number } | null {
  const buckets = snap?.buckets;
  if (!buckets?.length) return null;
  return (
    buckets.find(
      (b) =>
        /week/i.test(b.id) &&
        /all.?models|seven_day|current_week_all/i.test(`${b.id} ${b.label}`),
    ) ??
    buckets.find((b) => /week/i.test(b.id) || /week/i.test(b.label)) ??
    null
  );
}

/**
 * Future reset from an exhausted usage hint, if any.
 * Does **not** invent a +5h fallback — that belongs in note/sync when first recording exhaustion.
 */
export function futureResetMsFromUsageHint(
  snap: ClaudeUsageExhaustedHint | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!snap || snap.status !== 'exhausted') return null;
  const session = sessionBucketFromHint(snap);
  const week = weekBucketFromHint(snap);
  const weekBucket = snap.buckets?.find(
    (b) => /week/i.test(b.id) || /week/i.test(b.label),
  );
  const preferWeek = week != null && week.percentUsed >= 100;
  const candidates = preferWeek
    ? [weekBucket?.resetsAtIso, weekBucket?.resetsAt, session?.resetsAtIso, session?.resetsAt]
    : [session?.resetsAtIso, session?.resetsAt, weekBucket?.resetsAtIso, weekBucket?.resetsAt];
  for (const c of candidates) {
    const ms = parseClaudeResetToMs(c ?? null, nowMs);
    if (ms != null && ms > nowMs) return ms;
  }
  return null;
}

export function evaluateClaudeSpawn(
  purpose: ClaudeSpawnPurpose,
  opts: {
    nowMs?: number;
    softPercent?: number;
    state?: Readonly<ClaudeQuotaMemoryState>;
    usage?: ClaudeUsageExhaustedHint | null;
    /** Owner "Update now" — bypass soft/stale gates; still honors active hard_block_until. */
    forceUsageRefresh?: boolean;
  } = {},
): ClaudeSpawnDecision {
  const nowMs = opts.nowMs ?? Date.now();
  const softPercent = opts.softPercent ?? CLAUDE_QUOTA_SOFT_PERCENT_DEFAULT;
  const mem = opts.state ?? state;

  let sessionPercent = mem.sessionPercent;
  let weeklyPercent = mem.weeklyPercent;
  let blockedUntilMs = mem.blockedUntilMs;

  if (opts.usage) {
    const session = sessionBucketFromHint(opts.usage);
    const week = weekBucketFromHint(opts.usage);
    if (session) sessionPercent = session.percentUsed;
    if (week) weeklyPercent = week.percentUsed;
    const until = futureResetMsFromUsageHint(opts.usage, nowMs);
    if (until != null && until > blockedUntilMs) blockedUntilMs = until;
  }

  const hardBlock = nowMs < blockedUntilMs;

  // Live /usage: skip while hard_block_until is active (save quota), unless owner forces.
  // After the window, always allow — even if memory still says session 100% (stale).
  if (purpose === 'usage_refresh' || opts.forceUsageRefresh) {
    if (hardBlock && !opts.forceUsageRefresh) {
      return {
        allowed: false,
        reason: `hard_block_until:${new Date(blockedUntilMs).toISOString()}`,
        softBudget: false,
        hardBlock: true,
      };
    }
    return { allowed: true, reason: null, softBudget: false, hardBlock: false };
  }

  if (hardBlock) {
    return {
      allowed: false,
      reason: `hard_block_until:${new Date(blockedUntilMs).toISOString()}`,
      softBudget: false,
      hardBlock: true,
    };
  }

  // Past reset: stale session/week 100% must NOT hard-block (was session_exhausted:100 forever).
  const softSession =
    sessionPercent != null && sessionPercent >= softPercent && sessionPercent < 100;
  const softWeek =
    weeklyPercent != null && weeklyPercent >= softPercent && weeklyPercent < 100;

  if ((softSession || softWeek) && BACKGROUND_PURPOSES.has(purpose)) {
    return {
      allowed: false,
      reason: softWeek
        ? `soft_budget:week_${weeklyPercent}>=${softPercent}`
        : `soft_budget:session_${sessionPercent}>=${softPercent}`,
      softBudget: true,
      hardBlock: false,
    };
  }

  return { allowed: true, reason: null, softBudget: false, hardBlock: false };
}

/**
 * When `blockedUntil` has passed, drop stale hard-exhaustion markers so UI / retries
 * do not keep advertising 100% until the next live /usage lands.
 * Returns true if memory changed.
 */
export function releaseExpiredClaudeQuotaHardBlock(nowMs = Date.now()): boolean {
  if (state.blockedUntilMs > nowMs) return false;
  const staleHardSession = state.sessionPercent != null && state.sessionPercent >= 100;
  const staleHardWeek = state.weeklyPercent != null && state.weeklyPercent >= 100;
  if (state.blockedUntilMs <= 0 && !staleHardSession && !staleHardWeek && !state.reason) {
    return false;
  }
  // Keep soft-budget percents (<100); only clear hard 100 markers and expired until.
  state = {
    ...state,
    blockedUntilMs: 0,
    reason: null,
    sessionPercent: staleHardSession ? null : state.sessionPercent,
    weeklyPercent: staleHardWeek ? null : state.weeklyPercent,
    limitKind: null,
    updatedAtMs: nowMs,
  };
  return true;
}

export function getClaudeQuotaCircuitState(nowMs = Date.now()): {
  open: boolean;
  blockedUntilMs: number;
  remainingMs: number;
  lastDetail: string | null;
  sessionPercent: number | null;
} {
  const open = nowMs < state.blockedUntilMs;
  return {
    open,
    blockedUntilMs: state.blockedUntilMs,
    remainingMs: open ? state.blockedUntilMs - nowMs : 0,
    lastDetail: state.reason,
    sessionPercent: state.sessionPercent,
  };
}

/**
 * Open/extend hard circuit from a live 429 (or internal monitor reason).
 * Prefers parseable reset time; falls back to 5h (session) or 7d (weekly).
 */
export function noteClaudeRateLimit(detail?: string | null, nowMs = Date.now()): void {
  const text = (detail ?? '').trim();
  // Idempotent skip reasons — do not re-open / shorten the circuit.
  if (
    text.startsWith('hard_block_') ||
    text.startsWith('soft_budget:') ||
    text.startsWith('session_exhausted:') ||
    text.startsWith('week_exhausted:')
  ) {
    return;
  }
  if (
    text &&
    !isClaudeRateLimitSignal(text) &&
    !text.startsWith('usage_') &&
    !text.startsWith('skip_') &&
    !text.startsWith('quota_')
  ) {
    return;
  }

  const isWeekly = /weekly limit|current week/i.test(text);
  const parsed = parseClaudeResetToMs(text, nowMs);
  const fallbackMs = isWeekly
    ? 7 * 24 * 60 * 60 * 1000
    : CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS;
  const until =
    parsed ?? Math.max(state.blockedUntilMs, nowMs + fallbackMs);

  state = {
    ...state,
    blockedUntilMs: Math.max(state.blockedUntilMs, until),
    reason: text || state.reason || 'rate_limit',
    limitKind: isWeekly ? 'weekly' : /session limit/i.test(text) ? 'session' : state.limitKind ?? 'unknown',
    sessionPercent: isWeekly
      ? state.sessionPercent
      : Math.max(state.sessionPercent ?? 100, 100),
    weeklyPercent: isWeekly
      ? 100
      : state.weeklyPercent,
    sessionResetsAtIso: parsed != null ? new Date(parsed).toISOString() : state.sessionResetsAtIso,
    updatedAtMs: nowMs,
  };
}

/** Merge usage snapshot into memory (percentages + reset). */
export function syncClaudeQuotaFromUsage(
  snap: ClaudeUsageExhaustedHint | null | undefined,
  nowMs = Date.now(),
): void {
  if (!snap) return;
  const session = sessionBucketFromHint(snap);
  const week = weekBucketFromHint(snap);

  let blockedUntilMs = state.blockedUntilMs;
  let reason = state.reason;

  const hardSession = session != null && session.percentUsed >= 100;
  const hardWeek = week != null && week.percentUsed >= 100;
  const exhausted =
    snap.status === 'exhausted' || hardSession || hardWeek;

  if (exhausted) {
    const weekBucket = snap.buckets?.find(
      (b) => /week/i.test(b.id) || /week/i.test(b.label),
    );
    const until = futureResetMsFromUsageHint(
      {
        status: 'exhausted',
        checkedAt: snap.checkedAt,
        buckets: snap.buckets,
        worstPercent: snap.worstPercent,
      },
      nowMs,
    );

    if (until != null && until > nowMs) {
      if (until > blockedUntilMs) {
        blockedUntilMs = until;
        reason =
          reason ??
          `usage_exhausted:${hardWeek ? weekBucket?.label ?? 'week' : session?.label ?? snap.status}`;
      }
    } else if (blockedUntilMs > 0 && blockedUntilMs <= nowMs) {
      // Snapshot still says exhausted but reset window already passed — clear time lock.
      // (Do not re-arm +5h here; live 429 via noteClaudeRateLimit arms the circuit.)
      blockedUntilMs = 0;
      reason = null;
    }
  }

  if (snap.status === 'ok' && (session == null || session.percentUsed < 100) && !hardWeek) {
    if (nowMs >= blockedUntilMs || (session != null && session.percentUsed < 90)) {
      blockedUntilMs = 0;
      reason = null;
    }
  }

  state = {
    blockedUntilMs,
    reason,
    sessionPercent: session?.percentUsed ?? state.sessionPercent,
    weeklyPercent: week?.percentUsed ?? state.weeklyPercent,
    sessionResetsAtIso: session?.resetsAtIso ?? state.sessionResetsAtIso,
    limitKind:
      hardWeek
        ? 'weekly'
        : hardSession
          ? 'session'
          : snap.status === 'ok'
            ? null
            : state.limitKind,
    updatedAtMs: nowMs,
  };
}

export function clearClaudeQuotaCircuit(): void {
  state = emptyState();
}

export function isClaudeQuotaCircuitOpen(nowMs = Date.now()): boolean {
  return nowMs < state.blockedUntilMs;
}

/** @deprecated Use evaluateClaudeSpawn('usage_refresh', { usage: snap }) */
export function shouldSkipForceLiveUsageRefresh(
  snap: ClaudeUsageExhaustedHint | null | undefined,
  nowMs = Date.now(),
  _maxAgeMs = CLAUDE_USAGE_EXHAUSTED_SKIP_LIVE_MS,
): boolean {
  const decision = evaluateClaudeSpawn('usage_refresh', { nowMs, usage: snap });
  return !decision.allowed;
}

export function isClaudeBackgroundSpawnBlocked(
  snap?: ClaudeUsageExhaustedHint | null,
  nowMs = Date.now(),
  softPercent = CLAUDE_QUOTA_SOFT_PERCENT_DEFAULT,
): { blocked: boolean; reason: string | null } {
  const decision = evaluateClaudeSpawn('conversation_retry', {
    nowMs,
    usage: snap,
    softPercent,
  });
  return { blocked: !decision.allowed, reason: decision.reason };
}

/**
 * Warmup must never open the hard circuit (a boot ping 429 would brick IG).
 * Live customer/admin 429s still arm via `noteClaudeRateLimit`.
 */
export function shouldArmClaudeQuotaCircuit(
  purpose: ClaudeSpawnPurpose | undefined,
  armQuotaCircuit?: boolean,
): boolean {
  if (armQuotaCircuit === false) return false;
  if (purpose === 'warmup') return false;
  return true;
}

export function isBotFailureRateLimited(detail?: string | null): boolean {
  if (!detail?.trim()) return false;
  return isClaudeRateLimitSignal(detail);
}

export function purposeFromAgentChannel(
  channel: string | null | undefined,
): ClaudeSpawnPurpose {
  if (!channel) return 'unspecified';
  if (channel === 'ig' || channel === 'tg') return 'customer_dm';
  if (channel === 'insights' || channel === 'sandbox' || channel === 'teach') return 'admin';
  return 'admin';
}

export function _resetClaudeQuotaCircuitForTests(): void {
  state = emptyState();
}

/** Test helper — set memory without persist. */
export function _setClaudeQuotaMemoryForTests(next: Partial<ClaudeQuotaMemoryState>): void {
  hydrateClaudeQuotaMemory(next);
}
