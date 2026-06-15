import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  CLAUDE_USAGE_NOTIFY_KEY,
  CLAUDE_USAGE_SNAPSHOT_KEY,
  fetchClaudeUsageSnapshot,
  type ClaudeUsageSnapshot,
  type ClaudeUsageStatus,
} from './claude-usage.js';
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

/** Fetch live usage, persist, and optionally alert managers via Telegram. */
export async function runClaudeUsageCheck(): Promise<ClaudeUsageSnapshot> {
  const snapshot = await fetchClaudeUsageSnapshot();
  await persistSnapshot(snapshot);

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
    { intervalMin: config.CLAUDE_USAGE_CHECK_INTERVAL_MIN, warningPercent: config.CLAUDE_USAGE_WARNING_PERCENT },
    'Claude usage monitor started',
  );
}

export function stopClaudeUsageMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
