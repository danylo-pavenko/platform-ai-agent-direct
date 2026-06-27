import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { prisma } from '../lib/prisma.js';
import { getClaudeAuthStatus, type ClaudeAuthStatus } from './claude-auth.js';
import { notifyClaudeAuthRequired } from './telegram-notify.js';

const log = pino({ name: 'claude-auth-monitor' });

export const CLAUDE_AUTH_NOTIFY_KEY = 'claude_auth_notify_state';

const TICK_MS = 60_000;

interface NotifyState {
  lastRunDate: string;
  lastNotifiedDate: string | null;
  lastLoggedIn: boolean;
}

interface LocalDateParts {
  dateKey: string;
  hour: number;
  minute: number;
}

export function getLocalDateParts(timeZone: string, date = new Date()): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

export function shouldRunDailyCheck(
  now: Date,
  hour: number,
  timeZone: string,
  lastRunDateKey: string | null,
): { run: boolean; dateKey: string } {
  const { dateKey, hour: localHour } = getLocalDateParts(timeZone, now);
  if (lastRunDateKey === dateKey) {
    return { run: false, dateKey };
  }
  if (localHour < hour) {
    return { run: false, dateKey };
  }
  return { run: true, dateKey };
}

export function needsClaudeAuthAlert(status: ClaudeAuthStatus): boolean {
  if (status.loginInProgress) return false;
  return !status.loggedIn;
}

async function loadNotifyState(): Promise<NotifyState | null> {
  const row = await prisma.setting.findUnique({ where: { key: CLAUDE_AUTH_NOTIFY_KEY } });
  if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
  const v = row.value as Record<string, unknown>;
  if (typeof v.lastRunDate !== 'string') return null;
  return {
    lastRunDate: v.lastRunDate,
    lastNotifiedDate: typeof v.lastNotifiedDate === 'string' ? v.lastNotifiedDate : null,
    lastLoggedIn: v.lastLoggedIn === true,
  };
}

async function saveNotifyState(state: NotifyState): Promise<void> {
  const value = state as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: CLAUDE_AUTH_NOTIFY_KEY },
    create: { key: CLAUDE_AUTH_NOTIFY_KEY, value },
    update: { value },
  });
}

/** Probe Claude auth and alert managers via Telegram when the session is stale. */
export async function runClaudeAuthDailyCheck(): Promise<void> {
  const { telegram } = await getIntegrationConfig();
  if (!telegram.botToken) {
    log.debug('Skipping Claude auth daily check — Telegram bot not configured');
    return;
  }

  const status = await getClaudeAuthStatus({ skipLiveCache: true });
  const prev = await loadNotifyState();
  const { dateKey } = getLocalDateParts(config.CLAUDE_AUTH_CHECK_TIMEZONE);

  log.info(
    {
      loggedIn: status.loggedIn,
      sessionExpired: status.sessionExpired,
      binaryOk: status.binaryOk,
      loginInProgress: status.loginInProgress,
    },
    'Claude auth daily check completed',
  );

  const nextState: NotifyState = {
    lastRunDate: dateKey,
    lastNotifiedDate: prev?.lastNotifiedDate ?? null,
    lastLoggedIn: status.loggedIn,
  };

  if (needsClaudeAuthAlert(status)) {
    if (prev?.lastNotifiedDate !== dateKey) {
      log.warn(
        {
          event: 'claude_auth_stale',
          sessionExpired: status.sessionExpired,
          binaryOk: status.binaryOk,
        },
        'Claude auth unavailable — notifying managers via Telegram',
      );
      await notifyClaudeAuthRequired({
        sessionExpired: status.sessionExpired,
        binaryOk: status.binaryOk,
      });
      nextState.lastNotifiedDate = dateKey;
    }
  } else if (prev && !prev.lastLoggedIn && status.loggedIn) {
    log.info('Claude auth recovered after previous alert');
    nextState.lastNotifiedDate = null;
  }

  await saveNotifyState(nextState);
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastRunDateKey: string | null = null;

function tick(): void {
  const decision = shouldRunDailyCheck(
    new Date(),
    config.CLAUDE_AUTH_CHECK_HOUR,
    config.CLAUDE_AUTH_CHECK_TIMEZONE,
    lastRunDateKey,
  );
  if (!decision.run) return;

  lastRunDateKey = decision.dateKey;
  void runClaudeAuthDailyCheck().catch((err) => {
    log.warn({ err }, 'Claude auth daily check failed');
  });
}

export async function bootstrapClaudeAuthMonitorState(): Promise<void> {
  const state = await loadNotifyState();
  lastRunDateKey = state?.lastRunDate ?? null;
}

export function startClaudeAuthMonitor(appLog?: FastifyBaseLogger): void {
  if (!config.CLAUDE_AUTH_CHECK_ENABLED) {
    (appLog ?? log).info('Claude auth monitor disabled (CLAUDE_AUTH_CHECK_ENABLED=false)');
    return;
  }

  void bootstrapClaudeAuthMonitorState().catch((err) => {
    (appLog ?? log).warn({ err }, 'Failed to load Claude auth monitor state');
  });

  tick();
  monitorTimer = setInterval(tick, TICK_MS);
  (appLog ?? log).info(
    {
      hour: config.CLAUDE_AUTH_CHECK_HOUR,
      timeZone: config.CLAUDE_AUTH_CHECK_TIMEZONE,
    },
    'Claude auth monitor started',
  );
}

export function stopClaudeAuthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
