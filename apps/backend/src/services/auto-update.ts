/**
 * Midnight auto-update: poll Super Admin for a newer VERSION.code and request Deploy.
 *
 * Tenant does not pull/build itself — SA runs the existing deploy-client.sh pipeline
 * (with hard rollback on build/health fail). Schedule = 00:00 in agent_config.timezone.
 */

import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { getAgentConfig } from '../lib/agent-config.js';
import { config } from '../config.js';
import { getPlatformVersion } from '../lib/platform-version-runtime.js';
import {
  parsePlatformVersion,
  shouldRequestAutoUpdate,
  type PlatformVersion,
} from '../lib/platform-version.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  getZonedDateTimeParts,
} from '../lib/tenant-timezone.js';
import { msUntilNextLocalHour } from './log-retention.js';

const log = pino({ name: 'auto-update' });

/** Local midnight hour (tenant TZ) when the version gate runs. */
export const AUTO_UPDATE_HOUR = 0;

export type AutoUpdateTickResult =
  | { action: 'skipped'; reason: string }
  | { action: 'noop'; reason: string; localCode: number; remoteCode: number }
  | {
      action: 'requested';
      localCode: number;
      remoteCode: number;
      started: boolean;
      reason?: string;
    }
  | { action: 'error'; reason: string };

let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let hourlyTimer: ReturnType<typeof setInterval> | null = null;
let lastRunDayKey = '';

function dayKey(now: Date, timeZone: string): string {
  const p = getZonedDateTimeParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

async function resolveTimezone(): Promise<string> {
  try {
    const cfg = await getAgentConfig();
    return cfg.timezone || DEFAULT_TENANT_TIMEZONE;
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

export function msUntilNextLocalMidnight(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): number {
  return msUntilNextLocalHour(now, AUTO_UPDATE_HOUR, timeZone);
}

/** Pure gate used by tests — decide whether to POST auto-update. */
export function evaluateAutoUpdateGate(opts: {
  autoUpdateEnabled: boolean;
  saConfigured: boolean;
  localCode: number;
  remote: PlatformVersion | null;
}): { shouldRequest: boolean; reason: string } {
  if (!opts.autoUpdateEnabled) {
    return { shouldRequest: false, reason: 'autoUpdateEnabled=false' };
  }
  if (!opts.saConfigured) {
    return { shouldRequest: false, reason: 'SA_INTERNAL_URL or SUPERVISOR_SHARED_SECRET missing' };
  }
  if (!opts.remote) {
    return { shouldRequest: false, reason: 'invalid remote version' };
  }
  if (!shouldRequestAutoUpdate(opts.localCode, opts.remote.code)) {
    return {
      shouldRequest: false,
      reason:
        opts.remote.code <= opts.localCode
          ? 'local already current or newer'
          : 'version compare skipped',
    };
  }
  return { shouldRequest: true, reason: 'remote code higher' };
}

async function fetchRemoteVersion(
  saBase: string,
  secret: string,
): Promise<PlatformVersion | null> {
  const url = `${saBase.replace(/\/$/, '')}/api/platform/version`;
  const res = await fetch(url, {
    headers: { 'X-Supervisor-Token': secret },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`platform/version HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  return parsePlatformVersion(data);
}

async function requestAutoUpdate(
  saBase: string,
  secret: string,
  instanceId: string,
): Promise<{ started: boolean; reason?: string }> {
  const url = `${saBase.replace(/\/$/, '')}/api/tenants/by-instance/${encodeURIComponent(instanceId)}/auto-update`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Supervisor-Token': secret,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    started?: boolean;
    reason?: string;
    error?: string;
  };
  if (res.status === 409) {
    return { started: false, reason: data.reason ?? data.error ?? 'job already running' };
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `auto-update HTTP ${res.status}`);
  }
  return {
    started: Boolean(data.started),
    reason: data.reason,
  };
}

/**
 * One tick: load config, compare VERSION.code with SA, optionally POST auto-update.
 * Never throws to caller — errors become { action: 'error' }.
 */
export async function runAutoUpdateTick(opts?: {
  now?: Date;
  fetchVersion?: typeof fetchRemoteVersion;
  requestUpdate?: typeof requestAutoUpdate;
  getLocalVersion?: () => PlatformVersion;
}): Promise<AutoUpdateTickResult> {
  try {
    const cfg = await getAgentConfig();
    const saConfigured = Boolean(config.SA_INTERNAL_URL && config.SUPERVISOR_SHARED_SECRET);
    const local = (opts?.getLocalVersion ?? getPlatformVersion)();

    if (!cfg.autoUpdateEnabled) {
      return { action: 'skipped', reason: 'autoUpdateEnabled=false' };
    }
    if (!saConfigured) {
      return {
        action: 'skipped',
        reason: 'SA_INTERNAL_URL or SUPERVISOR_SHARED_SECRET missing',
      };
    }

    const fetchVersion = opts?.fetchVersion ?? fetchRemoteVersion;
    const remote = await fetchVersion(config.SA_INTERNAL_URL, config.SUPERVISOR_SHARED_SECRET);
    if (!remote) {
      return { action: 'error', reason: 'invalid remote version payload' };
    }

    const gate = evaluateAutoUpdateGate({
      autoUpdateEnabled: cfg.autoUpdateEnabled,
      saConfigured,
      localCode: local.code,
      remote,
    });
    if (!gate.shouldRequest) {
      return {
        action: 'noop',
        reason: gate.reason,
        localCode: local.code,
        remoteCode: remote.code,
      };
    }

    const requestUpdate = opts?.requestUpdate ?? requestAutoUpdate;
    const result = await requestUpdate(
      config.SA_INTERNAL_URL,
      config.SUPERVISOR_SHARED_SECRET,
      config.INSTANCE_ID,
    );
    return {
      action: 'requested',
      localCode: local.code,
      remoteCode: remote.code,
      started: result.started,
      reason: result.reason,
    };
  } catch (err) {
    return {
      action: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function maybeRunMidnight(appLog?: FastifyBaseLogger): Promise<void> {
  const timeZone = await resolveTimezone();
  const now = new Date();
  const parts = getZonedDateTimeParts(now, timeZone);
  if (parts.hour !== AUTO_UPDATE_HOUR) return;
  const key = dayKey(now, timeZone);
  if (key === lastRunDayKey) return;
  lastRunDayKey = key;

  const result = await runAutoUpdateTick({ now });
  const logger = appLog ?? log;
  if (result.action === 'requested') {
    logger.info(result, 'Tenant auto-update tick');
  } else if (result.action === 'error') {
    logger.warn(result, 'Tenant auto-update tick failed');
  } else {
    logger.info(result, 'Tenant auto-update tick');
  }
}

export function startAutoUpdateMonitor(appLog?: FastifyBaseLogger): void {
  stopAutoUpdateMonitor();

  void (async () => {
    const timeZone = await resolveTimezone();
    const delay = msUntilNextLocalMidnight(new Date(), timeZone);
    (appLog ?? log).info(
      {
        delayMs: delay,
        hour: AUTO_UPDATE_HOUR,
        timeZone,
        instanceId: config.INSTANCE_ID,
      },
      'Auto-update scheduled (midnight salon TZ → SA Deploy)',
    );

    midnightTimer = setTimeout(() => {
      midnightTimer = null;
      void maybeRunMidnight(appLog).catch((err) => {
        (appLog ?? log).warn({ err }, 'Tenant auto-update failed');
      });
    }, delay);
  })();

  hourlyTimer = setInterval(() => {
    void maybeRunMidnight(appLog).catch((err) => {
      (appLog ?? log).warn({ err }, 'Tenant auto-update failed');
    });
  }, 60 * 60 * 1000);
}

export function stopAutoUpdateMonitor(): void {
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
  if (hourlyTimer) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
}

/** Test helper */
export function resetAutoUpdateMonitorForTests(): void {
  stopAutoUpdateMonitor();
  lastRunDayKey = '';
}
