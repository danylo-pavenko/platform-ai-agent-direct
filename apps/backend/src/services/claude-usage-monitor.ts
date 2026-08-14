import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { evaluateClaudeSpawn } from '../lib/claude-quota-gate.js';
import {
  CLAUDE_USAGE_NOTIFY_KEY,
  CLAUDE_USAGE_SNAPSHOT_KEY,
  fetchClaudeUsageSnapshot,
  type ClaudeUsageSnapshot,
  type ClaudeUsageStatus,
} from './claude-usage.js';
import { applyUsageSnapshotToQuota, buildQuotaBlockedUsageSnapshot } from './claude-quota.js';
import { notifyClaudeUsageLimit } from './telegram-notify.js';

const log = pino({ name: 'claude-usage-monitor' });

interface NotifyState {
  status: ClaudeUsageStatus | null;
  worstPercent: number;
  notifiedAt: string;
}

const NOTIFY_THRESHOLDS = [90, 95, 99, 100];

function thresholdLevel(percent: number): number {
  let level = 0;
  for (const t of NOTIFY_THRESHOLDS) {
    if (percent >= t) level++;
  }
  return level;
}

function shouldNotifyTelegram(prev: NotifyState | null, snap: ClaudeUsageSnapshot): boolean {
  if (snap.status !== 'warning' && snap.status !== 'exhausted') {
    return false;
  }
  if (!prev) return true;
  if (prev.status !== snap.status) return true;
  return thresholdLevel(snap.worstPercent) > thresholdLevel(prev.worstPercent);
}

async function loadNotifyState(): Promise<NotifyState | null> {
  const row = await prisma.setting.findUnique({ where: { key: CLAUDE_USAGE_NOTIFY_KEY } });
  if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
  const v = row.value as Record<string, unknown>;
  if (typeof v.notifiedAt !== 'string') return null;
  return {
    status: typeof v.status === 'string' ? (v.status as ClaudeUsageStatus) : null,
    worstPercent: typeof v.worstPercent === 'number' ? v.worstPercent : 0,
    notifiedAt: v.notifiedAt,
  };
}

async function saveNotifyState(state: NotifyState): Promise<void> {
  const value = state as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: CLAUDE_USAGE_NOTIFY_KEY },
    create: { key: CLAUDE_USAGE_NOTIFY_KEY, value },
    update: { value },
  });
}

async function persistSnapshot(snapshot: ClaudeUsageSnapshot): Promise<void> {
  const value = snapshot as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: CLAUDE_USAGE_SNAPSHOT_KEY },
    create: { key: CLAUDE_USAGE_SNAPSHOT_KEY, value },
    update: { value },
  });
}

export async function loadClaudeUsageSnapshot(): Promise<ClaudeUsageSnapshot | null> {
  const row = await prisma.setting.findUnique({ where: { key: CLAUDE_USAGE_SNAPSHOT_KEY } });
  if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
  return row.value as unknown as ClaudeUsageSnapshot;
}

/** Fetch live usage (force CLI /usage), persist, and optionally alert managers via Telegram. */
let usageCheckInFlight: Promise<ClaudeUsageSnapshot> | null = null;

export async function runClaudeUsageCheck(): Promise<ClaudeUsageSnapshot> {
  if (usageCheckInFlight) return usageCheckInFlight;

  usageCheckInFlight = (async () => {
    const prevSnap = await loadClaudeUsageSnapshot();
    const gate = evaluateClaudeSpawn('usage_refresh', {
      usage: prevSnap,
      softPercent: config.CLAUDE_QUOTA_SOFT_PERCENT,
    });
    if (!gate.allowed) {
      const kept = buildQuotaBlockedUsageSnapshot(prevSnap);
      log.info(
        {
          status: kept.status,
          worstPercent: kept.worstPercent,
          skippedLive: true,
          reason: gate.reason,
          previousCheckedAt: prevSnap?.checkedAt ?? null,
        },
        'Skipping live /usage — quota gate',
      );
      await persistSnapshot(kept);
      // Do not re-record gate.reason (hard_block_…) — circuit already open.
      return kept;
    }

    const snapshot = await fetchClaudeUsageSnapshot({ forceLive: true });

    // Transient CLI failures (timeout / parse) must not wipe the last good snapshot.
    const transientFailure =
      snapshot.status === 'unavailable' &&
      snapshot.error != null &&
      snapshot.error !== 'not_authenticated' &&
      snapshot.buckets.length === 0;

    if (transientFailure) {
      const prev = prevSnap ?? (await loadClaudeUsageSnapshot());
      if (prev && prev.buckets.length > 0) {
        const merged: ClaudeUsageSnapshot = {
          ...prev,
          checkedAt: snapshot.checkedAt,
          error: snapshot.error,
          message: `Останні відомі ліміти (оновлення не вдалось: ${snapshot.error}). ${prev.message}`,
        };
        log.warn(
          { error: snapshot.error, keptBuckets: prev.buckets.length },
          'Claude usage live check failed — keeping previous snapshot',
        );
        await persistSnapshot(merged);
        await applyUsageSnapshotToQuota(merged);
        return merged;
      }
    }

    await persistSnapshot(snapshot);
    await applyUsageSnapshotToQuota(snapshot);

    log.info(
      {
        status: snapshot.status,
        worstPercent: snapshot.worstPercent,
        buckets: snapshot.buckets.length,
        subscriptionType: snapshot.subscriptionType,
      },
      'Claude usage check completed',
    );

    if (snapshot.status === 'warning' || snapshot.status === 'exhausted') {
      const prev = await loadNotifyState();
      if (shouldNotifyTelegram(prev, snapshot)) {
        log.warn(
          {
            event: 'claude_usage_limit',
            status: snapshot.status,
            worstPercent: snapshot.worstPercent,
            buckets: snapshot.buckets,
          },
          'Claude usage limit threshold reached — notifying managers',
        );
        await notifyClaudeUsageLimit({
          status: snapshot.status,
          worstPercent: snapshot.worstPercent,
          buckets: snapshot.buckets,
          subscriptionType: snapshot.subscriptionType,
          message: snapshot.message,
        });
        await saveNotifyState({
          status: snapshot.status,
          worstPercent: snapshot.worstPercent,
          notifiedAt: new Date().toISOString(),
        });
      }
    } else if (snapshot.status === 'ok') {
      const prev = await loadNotifyState();
      if (prev && (prev.status === 'warning' || prev.status === 'exhausted')) {
        log.info({ previousStatus: prev.status }, 'Claude usage recovered to ok');
      }
      await saveNotifyState({
        status: 'ok',
        worstPercent: snapshot.worstPercent,
        notifiedAt: new Date().toISOString(),
      });
    }

    return snapshot;
  })();

  const pending = usageCheckInFlight;
  try {
    return await pending;
  } finally {
    if (usageCheckInFlight === pending) usageCheckInFlight = null;
  }
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function startClaudeUsageMonitor(appLog?: FastifyBaseLogger): void {
  if (!config.CLAUDE_USAGE_CHECK_ENABLED) {
    (appLog ?? log).info('Claude usage monitor disabled (CLAUDE_USAGE_CHECK_ENABLED=false)');
    return;
  }

  const intervalMs = config.CLAUDE_USAGE_CHECK_INTERVAL_MIN * 60 * 1000;

  const run = () => {
    runClaudeUsageCheck().catch((err) => {
      (appLog ?? log).warn({ err }, 'Claude usage check failed');
    });
  };

  run();
  monitorTimer = setInterval(run, intervalMs);
  (appLog ?? log).info(
    {
      intervalMin: config.CLAUDE_USAGE_CHECK_INTERVAL_MIN,
      warningPercent: config.CLAUDE_USAGE_WARNING_PERCENT,
      mode: 'forceLive_/usage',
    },
    'Claude usage monitor started (live /usage every interval)',
  );
}

export function stopClaudeUsageMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
