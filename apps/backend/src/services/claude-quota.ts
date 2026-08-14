/**
 * Persist Claude quota circuit across PM2 restarts and sync from usage snapshots.
 */

import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  clearClaudeQuotaCircuit,
  evaluateClaudeSpawn,
  getClaudeQuotaMemoryState,
  hydrateClaudeQuotaMemory,
  noteClaudeRateLimit,
  syncClaudeQuotaFromUsage,
  type ClaudeSpawnPurpose,
  type ClaudeUsageExhaustedHint,
} from '../lib/claude-quota-gate.js';
import type { ClaudeUsageBucket, ClaudeUsageSnapshot } from './claude-usage.js';

const log = pino({ name: 'claude-quota' });

export const CLAUDE_QUOTA_CIRCUIT_KEY = 'claude_quota_circuit';

interface PersistedQuotaCircuit {
  blockedUntilMs: number;
  reason: string | null;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetsAtIso: string | null;
  limitKind: 'session' | 'weekly' | 'unknown' | null;
  updatedAt: string;
}

function softPercent(): number {
  return config.CLAUDE_QUOTA_SOFT_PERCENT;
}

function formatResetUk(ms: number): string {
  try {
    return new Date(ms).toLocaleString('uk-UA', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export async function loadClaudeQuotaCircuit(): Promise<void> {
  try {
    const row = await prisma.setting.findUnique({
      where: { key: CLAUDE_QUOTA_CIRCUIT_KEY },
    });
    if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) {
      return;
    }
    const v = row.value as Record<string, unknown>;
    const blockedUntilMs =
      typeof v.blockedUntilMs === 'number' ? v.blockedUntilMs : 0;
    const limitKind =
      v.limitKind === 'session' || v.limitKind === 'weekly' || v.limitKind === 'unknown'
        ? v.limitKind
        : null;
    hydrateClaudeQuotaMemory({
      blockedUntilMs,
      reason: typeof v.reason === 'string' ? v.reason : null,
      sessionPercent: typeof v.sessionPercent === 'number' ? v.sessionPercent : null,
      weeklyPercent: typeof v.weeklyPercent === 'number' ? v.weeklyPercent : null,
      sessionResetsAtIso:
        typeof v.sessionResetsAtIso === 'string' ? v.sessionResetsAtIso : null,
      limitKind,
      updatedAtMs: typeof v.updatedAt === 'string' ? Date.parse(v.updatedAt) : Date.now(),
    });
    const mem = getClaudeQuotaMemoryState();
    if (mem.blockedUntilMs > Date.now()) {
      log.info(
        {
          blockedUntil: new Date(mem.blockedUntilMs).toISOString(),
          reason: mem.reason,
          sessionPercent: mem.sessionPercent,
          weeklyPercent: mem.weeklyPercent,
          limitKind: mem.limitKind,
        },
        'Claude quota circuit restored from DB',
      );
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load Claude quota circuit from DB');
  }
}

export async function persistClaudeQuotaCircuit(): Promise<void> {
  const mem = getClaudeQuotaMemoryState();
  const value: PersistedQuotaCircuit = {
    blockedUntilMs: mem.blockedUntilMs,
    reason: mem.reason,
    sessionPercent: mem.sessionPercent,
    weeklyPercent: mem.weeklyPercent,
    sessionResetsAtIso: mem.sessionResetsAtIso,
    limitKind: mem.limitKind,
    updatedAt: new Date(mem.updatedAtMs || Date.now()).toISOString(),
  };
  try {
    const json = value as unknown as Prisma.InputJsonValue;
    await prisma.setting.upsert({
      where: { key: CLAUDE_QUOTA_CIRCUIT_KEY },
      create: { key: CLAUDE_QUOTA_CIRCUIT_KEY, value: json },
      update: { value: json },
    });
  } catch (err) {
    log.warn({ err }, 'Failed to persist Claude quota circuit');
  }
}

/** Record 429, update memory + DB. */
export async function recordClaudeRateLimit(detail?: string | null): Promise<void> {
  noteClaudeRateLimit(detail);
  await persistClaudeQuotaCircuit();
}

/** Apply usage snapshot → memory + DB. */
export async function applyUsageSnapshotToQuota(
  snap: ClaudeUsageExhaustedHint | null | undefined,
): Promise<void> {
  const before = getClaudeQuotaMemoryState().blockedUntilMs;
  syncClaudeQuotaFromUsage(snap);
  const after = getClaudeQuotaMemoryState().blockedUntilMs;
  if (snap?.status === 'ok' && after === 0 && before > 0) {
    clearClaudeQuotaCircuit();
    log.info('Claude quota circuit cleared — usage recovered to ok');
  }
  await persistClaudeQuotaCircuit();
}

/**
 * Clean admin snapshot while the quota circuit is open — never claim
 * "not authenticated" and never append repeated skip lines.
 */
export function buildQuotaBlockedUsageSnapshot(
  prev: ClaudeUsageSnapshot | null | undefined,
): ClaudeUsageSnapshot {
  const mem = getClaudeQuotaMemoryState();
  const now = Date.now();
  const untilMs = mem.blockedUntilMs > now ? mem.blockedUntilMs : now;
  const resetsLabel = formatResetUk(untilMs);
  const isWeekly =
    mem.limitKind === 'weekly' || /weekly/i.test(mem.reason ?? '');

  const sessionPct = Math.max(mem.sessionPercent ?? 0, isWeekly ? 0 : 100);
  const weeklyPct = Math.max(mem.weeklyPercent ?? 0, isWeekly ? 100 : 0);

  const prevBuckets = prev?.buckets?.filter((b) => b.percentUsed >= 0) ?? [];
  let buckets: ClaudeUsageBucket[] = prevBuckets.map((b) => {
    if (/week/i.test(b.id) || /week/i.test(b.label)) {
      return {
        ...b,
        percentUsed: Math.max(b.percentUsed, weeklyPct || b.percentUsed),
        resetsAt: isWeekly ? resetsLabel : b.resetsAt,
      };
    }
    if (/session/i.test(b.id) || /session/i.test(b.label)) {
      return {
        ...b,
        percentUsed: Math.max(b.percentUsed, sessionPct || b.percentUsed),
        resetsAt: !isWeekly ? resetsLabel : b.resetsAt,
      };
    }
    return b;
  });

  if (buckets.length === 0) {
    buckets = [
      {
        id: 'current_session',
        label: 'Current session',
        percentUsed: sessionPct || (isWeekly ? 0 : 100),
        resetsAt: isWeekly ? '—' : resetsLabel,
      },
      {
        id: 'current_week_all_models',
        label: 'Current week (all models)',
        percentUsed: weeklyPct || (isWeekly ? 100 : 0),
        resetsAt: isWeekly ? resetsLabel : '—',
      },
    ];
  }

  const worstPercent = Math.max(
    100,
    ...buckets.map((b) => b.percentUsed),
    sessionPct,
    weeklyPct,
  );

  const message = isWeekly
    ? `Тижневий ліміт Claude вичерпано. Скидається ${resetsLabel}. Live /usage не запускаємо, щоб не витрачати квоту. Авторизація в порядку — це ліміт підписки, не logout.`
    : `Ліміт сесії Claude вичерпано до ${resetsLabel}. Live /usage пропущено (quota gate). Авторизація в порядку.`;

  return {
    checkedAt: new Date().toISOString(),
    status: 'exhausted',
    subscriptionType: prev?.subscriptionType ?? null,
    authEmail: prev?.authEmail ?? null,
    buckets,
    worstPercent,
    message,
    rawText: null,
    error: null,
    cacheFetchedAt: prev?.cacheFetchedAt ?? null,
    cacheStale: false,
  };
}

export function assertClaudeSpawnAllowed(
  purpose: ClaudeSpawnPurpose,
  usage?: ClaudeUsageExhaustedHint | null,
): { allowed: true } | { allowed: false; reason: string } {
  const decision = evaluateClaudeSpawn(purpose, {
    usage,
    softPercent: softPercent(),
  });
  if (!decision.allowed) {
    log.info(
      { purpose, reason: decision.reason, softBudget: decision.softBudget },
      'Claude spawn denied by quota gate',
    );
    return { allowed: false, reason: decision.reason ?? 'quota_gate' };
  }
  return { allowed: true };
}
