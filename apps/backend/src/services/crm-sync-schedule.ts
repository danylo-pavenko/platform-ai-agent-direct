/**
 * Daily CRM sync schedule (catalog / services / masters).
 *
 * PM2 `{INSTANCE}-sync` with cron_restart was unreliable: deploy restarted the
 * one-shot process at random times, and server TZ ≠ salon TZ. The long-lived
 * API process owns the schedule in the tenant timezone instead.
 *
 * CSV / Shop-Express catalog import is separate (admin upload) — this job only
 * pulls CRM and rebuilds file↔CRM matches afterward (inside runSync).
 */

import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { getZonedDateTimeParts, zonedWallTimeToUtcMs } from '../lib/tenant-timezone.js';
import { runSync, SyncInProgressError } from '../sync-worker.js';
import { shouldRunDailyCheck } from './claude-auth-monitor.js';

const log = pino({ name: 'crm-sync-schedule' });

const TICK_MS = 60_000;
/** Default 04:00 in salon TZ — matches admin Sync UI copy. */
export const DEFAULT_CRM_SYNC_HOUR = 4;

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastRunDateKey: string | null = null;
let tickInFlight = false;

function civilDateKey(timeZone: string, date = new Date()): string {
  const z = getZonedDateTimeParts(date, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

/** Civil-day start (tenant TZ) as UTC Date — for DB filters / tests. */
export function syncCivilDayStartUtc(timeZone: string, now = new Date()): Date {
  const z = getZonedDateTimeParts(now, timeZone);
  return new Date(
    zonedWallTimeToUtcMs({
      year: z.year,
      month: z.month,
      day: z.day,
      hour: 0,
      minute: 0,
      second: 0,
      timeZone,
    }),
  );
}

/** True if a sync run already started on this civil day (ok / error / running). */
export async function findSyncDateKeyIfRanToday(timeZone: string, now = new Date()): Promise<string | null> {
  const today = civilDateKey(timeZone, now);
  const row = await prisma.crmSyncRun.findFirst({
    where: { startedAt: { gte: syncCivilDayStartUtc(timeZone, now) } },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  return row ? today : null;
}

export async function bootstrapCrmSyncScheduleState(): Promise<void> {
  const agent = await getAgentConfig();
  lastRunDateKey = await findSyncDateKeyIfRanToday(agent.timezone);
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  if (!config.CRM_SYNC_DAILY_ENABLED) return;

  tickInFlight = true;
  try {
    const agent = await getAgentConfig();
    const hour = config.CRM_SYNC_HOUR;
    const decision = shouldRunDailyCheck(new Date(), hour, agent.timezone, lastRunDateKey);
    if (!decision.run) return;

    // Re-check DB in case another process (manual trigger / old PM2 sync) already ran.
    const already = await findSyncDateKeyIfRanToday(agent.timezone);
    if (already) {
      lastRunDateKey = already;
      return;
    }

    // Mark the civil day before runSync so we do not hammer CRM every minute on failure.
    lastRunDateKey = decision.dateKey;
    log.info(
      { dateKey: decision.dateKey, hour, timeZone: agent.timezone },
      'Daily CRM sync triggered by API schedule',
    );

    try {
      await runSync();
    } catch (err) {
      if (err instanceof SyncInProgressError) {
        log.warn({ err: err.message }, 'Daily CRM sync skipped — already in progress');
        return;
      }
      throw err;
    }
  } catch (err) {
    log.warn({ err }, 'Daily CRM sync schedule tick failed');
  } finally {
    tickInFlight = false;
  }
}

export function startCrmSyncSchedule(appLog?: FastifyBaseLogger): void {
  if (!config.CRM_SYNC_DAILY_ENABLED) {
    (appLog ?? log).info('Daily CRM sync schedule disabled (CRM_SYNC_DAILY_ENABLED=false)');
    return;
  }

  void bootstrapCrmSyncScheduleState()
    .then(() => tick())
    .catch((err) => {
      (appLog ?? log).warn({ err }, 'Failed to bootstrap CRM sync schedule');
    });

  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    void tick();
  }, TICK_MS);

  (appLog ?? log).info(
    { hour: config.CRM_SYNC_HOUR, tickMs: TICK_MS },
    'Daily CRM sync schedule started (tenant timezone)',
  );
}

export function stopCrmSyncSchedule(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
