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

const log = pino({ name: 'claude-quota' });

export const CLAUDE_QUOTA_CIRCUIT_KEY = 'claude_quota_circuit';

interface PersistedQuotaCircuit {
  blockedUntilMs: number;
  reason: string | null;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetsAtIso: string | null;
  updatedAt: string;
}

function softPercent(): number {
  return config.CLAUDE_QUOTA_SOFT_PERCENT;
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
    hydrateClaudeQuotaMemory({
      blockedUntilMs,
      reason: typeof v.reason === 'string' ? v.reason : null,
      sessionPercent: typeof v.sessionPercent === 'number' ? v.sessionPercent : null,
      weeklyPercent: typeof v.weeklyPercent === 'number' ? v.weeklyPercent : null,
      sessionResetsAtIso:
        typeof v.sessionResetsAtIso === 'string' ? v.sessionResetsAtIso : null,
      updatedAtMs: typeof v.updatedAt === 'string' ? Date.parse(v.updatedAt) : Date.now(),
    });
    const mem = getClaudeQuotaMemoryState();
    if (mem.blockedUntilMs > Date.now()) {
      log.info(
        {
          blockedUntil: new Date(mem.blockedUntilMs).toISOString(),
          reason: mem.reason,
          sessionPercent: mem.sessionPercent,
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
