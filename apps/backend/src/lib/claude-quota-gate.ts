/**
 * Circuit breaker for Claude subscription session/weekly limits (429).
 *
 * Background jobs (warmup, forceLive /usage, conversation retry, health latency)
 * must not keep spawning the CLI while the window is known-exhausted — each
 * spawn still burns quota / races the reset and prolongs outage.
 */

import { isClaudeRateLimitSignal } from './claude-auth-probe.js';

/** Minimal snapshot shape — avoids importing the usage service from lib/. */
export interface ClaudeUsageExhaustedHint {
  status: string;
  checkedAt: string;
}

/** How long an observed 429 blocks background + opportunistic spawns. */
export const CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS = 20 * 60 * 1000;

/**
 * Skip forceLive `/usage` while a recent snapshot already says exhausted.
 * Monitor interval is typically 30m — allow one live re-check after this age.
 */
export const CLAUDE_USAGE_EXHAUSTED_SKIP_LIVE_MS = 25 * 60 * 1000;

let blockedUntilMs = 0;
let lastRateLimitDetail: string | null = null;

export function getClaudeQuotaCircuitState(nowMs = Date.now()): {
  open: boolean;
  blockedUntilMs: number;
  remainingMs: number;
  lastDetail: string | null;
} {
  const open = nowMs < blockedUntilMs;
  return {
    open,
    blockedUntilMs,
    remainingMs: open ? blockedUntilMs - nowMs : 0,
    lastDetail: lastRateLimitDetail,
  };
}

/** Open (or extend) the in-memory circuit after a live 429 / session-limit signal. */
export function noteClaudeRateLimit(detail?: string | null, nowMs = Date.now()): void {
  const text = (detail ?? '').trim();
  // Auto-detect from CLI error text; allow explicit internal reasons from monitors.
  if (
    text &&
    !isClaudeRateLimitSignal(text) &&
    !text.startsWith('usage_') &&
    !text.startsWith('skip_') &&
    !text.startsWith('quota_')
  ) {
    return;
  }
  lastRateLimitDetail = text || lastRateLimitDetail || 'rate_limit';
  const until = nowMs + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS;
  if (until > blockedUntilMs) {
    blockedUntilMs = until;
  }
}

/** Clear circuit after a successful usage check that is no longer exhausted. */
export function clearClaudeQuotaCircuit(): void {
  blockedUntilMs = 0;
  lastRateLimitDetail = null;
}

export function isClaudeQuotaCircuitOpen(nowMs = Date.now()): boolean {
  return nowMs < blockedUntilMs;
}

/**
 * True when persisted/admin usage snapshot already shows plan exhaustion and
 * the observation is fresh enough that another `/usage` spawn is wasteful.
 */
export function shouldSkipForceLiveUsageRefresh(
  snap: ClaudeUsageExhaustedHint | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = CLAUDE_USAGE_EXHAUSTED_SKIP_LIVE_MS,
): boolean {
  if (!snap || snap.status !== 'exhausted') return false;
  const checkedMs = Date.parse(snap.checkedAt);
  if (!Number.isFinite(checkedMs)) return false;
  return nowMs - checkedMs < maxAgeMs;
}

/**
 * Background Claude spawns (warmup, retry monitor, latency probe) should wait.
 * Customer DMs still may call askClaude — it short-circuits when circuit is open.
 */
export function isClaudeBackgroundSpawnBlocked(
  snap?: ClaudeUsageExhaustedHint | null,
  nowMs = Date.now(),
): { blocked: boolean; reason: string | null } {
  if (isClaudeQuotaCircuitOpen(nowMs)) {
    return { blocked: true, reason: 'in_memory_rate_limit' };
  }
  if (shouldSkipForceLiveUsageRefresh(snap, nowMs)) {
    return { blocked: true, reason: 'usage_snapshot_exhausted' };
  }
  return { blocked: false, reason: null };
}

/** True when a stored botFailureDetail is a subscription/session limit. */
export function isBotFailureRateLimited(detail?: string | null): boolean {
  if (!detail?.trim()) return false;
  return isClaudeRateLimitSignal(detail);
}

/** Test helper — reset module state between cases. */
export function _resetClaudeQuotaCircuitForTests(): void {
  blockedUntilMs = 0;
  lastRateLimitDetail = null;
}
