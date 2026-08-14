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
 * - `resets Aug 14, 2:40pm (Europe/Berlin)`
 * - Display strings like `Aug 14, 2:40pm (Europe/Berlin)`
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

  // Optional date + time: Aug 14, 2:40pm  |  14 Aug 2026, 14:40  |  2:40pm
  const re =
    /(?:resets?\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?[, ]+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i;
  const m = raw.match(re);
  if (!m) return null;

  const monthName = m[1];
  const dayNum = m[2] ? Number(m[2]) : null;
  const yearNum = m[3] ? Number(m[3]) : null;
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const ampm = m[6]?.toLowerCase();

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const nowParts = getZonedParts(new Date(nowMs), timeZone);
  let year = yearNum ?? nowParts.year;
  let month = monthName ? MONTHS[monthName.toLowerCase()] : nowParts.month;
  let day = dayNum ?? nowParts.day;
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

export function evaluateClaudeSpawn(
  purpose: ClaudeSpawnPurpose,
  opts: {
    nowMs?: number;
    softPercent?: number;
    state?: Readonly<ClaudeQuotaMemoryState>;
    usage?: ClaudeUsageExhaustedHint | null;
  } = {},
): ClaudeSpawnDecision {
  const nowMs = opts.nowMs ?? Date.now();
  const softPercent = opts.softPercent ?? CLAUDE_QUOTA_SOFT_PERCENT_DEFAULT;
  const mem = opts.state ?? state;

  let sessionPercent = mem.sessionPercent;
  let blockedUntilMs = mem.blockedUntilMs;

  if (opts.usage) {
    const session = sessionBucketFromHint(opts.usage);
    if (session) sessionPercent = session.percentUsed;
    if (opts.usage.status === 'exhausted') {
      const fromIso = parseClaudeResetToMs(session?.resetsAtIso ?? null, nowMs);
      const fromDisplay = parseClaudeResetToMs(session?.resetsAt ?? null, nowMs);
      const until = fromIso ?? fromDisplay;
      if (until != null && until > blockedUntilMs) blockedUntilMs = until;
      // Exhausted without parseable reset → keep blocking background at least
      if (until == null && blockedUntilMs <= nowMs) {
        blockedUntilMs = nowMs + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS;
      }
    }
  }

  const hardBlock = nowMs < blockedUntilMs;
  if (hardBlock) {
    return {
      allowed: false,
      reason: `hard_block_until:${new Date(blockedUntilMs).toISOString()}`,
      softBudget: false,
      hardBlock: true,
    };
  }

  const soft =
    sessionPercent != null && sessionPercent >= softPercent && sessionPercent < 100;
  const hardSession = sessionPercent != null && sessionPercent >= 100;

  if (hardSession) {
    return {
      allowed: false,
      reason: `session_exhausted:${sessionPercent}`,
      softBudget: false,
      hardBlock: true,
    };
  }

  if (soft && BACKGROUND_PURPOSES.has(purpose)) {
    return {
      allowed: false,
      reason: `soft_budget:session_${sessionPercent}>=${softPercent}`,
      softBudget: true,
      hardBlock: false,
    };
  }

  // usage_refresh after hard block cleared: allowed (discover recovery)
  return { allowed: true, reason: null, softBudget: false, hardBlock: false };
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
 * Prefers parseable reset time; falls back to 5h session window.
 */
export function noteClaudeRateLimit(detail?: string | null, nowMs = Date.now()): void {
  const text = (detail ?? '').trim();
  if (
    text &&
    !isClaudeRateLimitSignal(text) &&
    !text.startsWith('usage_') &&
    !text.startsWith('skip_') &&
    !text.startsWith('quota_')
  ) {
    return;
  }

  const parsed = parseClaudeResetToMs(text, nowMs);
  const until =
    parsed ??
    Math.max(state.blockedUntilMs, nowMs + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS);

  state = {
    ...state,
    blockedUntilMs: Math.max(state.blockedUntilMs, until),
    reason: text || state.reason || 'rate_limit',
    sessionPercent: state.sessionPercent == null ? 100 : Math.max(state.sessionPercent, 100),
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

  if (snap.status === 'exhausted' || (session && session.percentUsed >= 100)) {
    const until =
      parseClaudeResetToMs(session?.resetsAtIso ?? null, nowMs) ??
      parseClaudeResetToMs(session?.resetsAt ?? null, nowMs) ??
      nowMs + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS;
    if (until > blockedUntilMs) {
      blockedUntilMs = until;
      reason = reason ?? `usage_exhausted:${session?.label ?? snap.status}`;
    }
  }

  if (snap.status === 'ok' && (session == null || session.percentUsed < 100)) {
    // Recovery — clear hard block if we're past it or usage says ok
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
