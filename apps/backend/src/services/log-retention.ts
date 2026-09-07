/**
 * Evening retention for tenant log files under $TENANT_KNOWLEDGE_DIR/logs.
 * - JSONL with `at` ISO field: keep lines newer than retentionDays
 * - Other files: delete when mtime older than retentionDays
 * Cron: once per evening (default 23:00 tenant timezone), hourly tick.
 */

import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { getAgentConfig } from '../lib/agent-config.js';
import { getTenantLogsDir } from '../lib/paths.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  getZonedDateTimeParts,
  zonedWallTimeToUtcMs,
} from '../lib/tenant-timezone.js';

const log = pino({ name: 'log-retention' });

export const LOG_RETENTION_DAYS = 7;
/** Local evening hour (tenant TZ) when cleanup runs. */
export const LOG_RETENTION_HOUR = 23;

export type LogRetentionResult = {
  dir: string;
  retentionDays: number;
  deletedFiles: string[];
  rewrittenFiles: Array<{ file: string; kept: number; dropped: number }>;
  errors: string[];
};

/** Keep JSONL lines whose `at` is within the retention window. */
export function filterJsonlByRetention(
  content: string,
  cutoffMs: number,
): { kept: string; keptCount: number; droppedCount: number } {
  const lines = content.split('\n');
  const out: string[] = [];
  let keptCount = 0;
  let droppedCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let atMs: number | null = null;
    try {
      const row = JSON.parse(trimmed) as { at?: unknown };
      if (typeof row.at === 'string') {
        const ms = Date.parse(row.at);
        if (Number.isFinite(ms)) atMs = ms;
      }
    } catch {
      droppedCount += 1;
      continue;
    }
    if (atMs == null || atMs < cutoffMs) {
      droppedCount += 1;
      continue;
    }
    out.push(trimmed);
    keptCount += 1;
  }
  return {
    kept: out.length > 0 ? `${out.join('\n')}\n` : '',
    keptCount,
    droppedCount,
  };
}

/** Civil +1 day (UTC date arithmetic — fine for Y-M-D calendars). */
export function addCivilDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

export function msUntilNextLocalHour(
  now: Date,
  hour: number,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): number {
  const parts = getZonedDateTimeParts(now, timeZone);
  const alreadyPassed =
    parts.hour > hour ||
    (parts.hour === hour && (parts.minute > 0 || parts.second > 0));
  const targetDay = alreadyPassed
    ? addCivilDays(parts.year, parts.month, parts.day, 1)
    : { year: parts.year, month: parts.month, day: parts.day };
  const targetMs = zonedWallTimeToUtcMs({
    ...targetDay,
    hour,
    minute: 0,
    second: 0,
    timeZone,
  });
  return Math.max(1_000, targetMs - now.getTime());
}

export async function purgeTenantLogs(opts?: {
  logsDir?: string;
  retentionDays?: number;
  now?: Date;
}): Promise<LogRetentionResult> {
  const dir = opts?.logsDir ?? getTenantLogsDir();
  const retentionDays = opts?.retentionDays ?? LOG_RETENTION_DAYS;
  const now = opts?.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * 24 * 3600_000;
  const result: LogRetentionResult = {
    dir,
    retentionDays,
    deletedFiles: [],
    rewrittenFiles: [],
    errors: [],
  };

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return result;
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;

      if (name.endsWith('.jsonl')) {
        const raw = await readFile(full, 'utf8');
        const { kept, keptCount, droppedCount } = filterJsonlByRetention(raw, cutoffMs);
        if (droppedCount === 0) continue;
        if (keptCount === 0) {
          await unlink(full);
          result.deletedFiles.push(name);
        } else {
          const tmp = `${full}.tmp`;
          await writeFile(tmp, kept, 'utf8');
          await rename(tmp, full);
          result.rewrittenFiles.push({
            file: name,
            kept: keptCount,
            dropped: droppedCount,
          });
        }
        continue;
      }

      if (st.mtimeMs < cutoffMs) {
        await unlink(full);
        result.deletedFiles.push(name);
      }
    } catch (err) {
      result.errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

let eveningTimer: ReturnType<typeof setTimeout> | null = null;
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

async function runRetentionOnce(appLog?: FastifyBaseLogger): Promise<void> {
  const result = await purgeTenantLogs();
  const logger = appLog ?? log;
  if (
    result.deletedFiles.length > 0 ||
    result.rewrittenFiles.length > 0 ||
    result.errors.length > 0
  ) {
    logger.info({ ...result }, 'Tenant log retention finished');
  } else {
    logger.info(
      { dir: result.dir, retentionDays: result.retentionDays },
      'Tenant log retention: nothing to purge',
    );
  }
}

async function maybeRunEvening(appLog?: FastifyBaseLogger): Promise<void> {
  const timeZone = await resolveTimezone();
  const now = new Date();
  const parts = getZonedDateTimeParts(now, timeZone);
  if (parts.hour !== LOG_RETENTION_HOUR) return;
  const key = dayKey(now, timeZone);
  if (key === lastRunDayKey) return;
  lastRunDayKey = key;
  await runRetentionOnce(appLog);
}

export function startLogRetentionMonitor(appLog?: FastifyBaseLogger): void {
  stopLogRetentionMonitor();

  void (async () => {
    const timeZone = await resolveTimezone();
    const delay = msUntilNextLocalHour(new Date(), LOG_RETENTION_HOUR, timeZone);
    (appLog ?? log).info(
      {
        delayMs: delay,
        hour: LOG_RETENTION_HOUR,
        timeZone,
        retentionDays: LOG_RETENTION_DAYS,
        logsDir: getTenantLogsDir(),
      },
      'Log retention scheduled (evening cron, keep 7 days)',
    );

    eveningTimer = setTimeout(() => {
      eveningTimer = null;
      void maybeRunEvening(appLog).catch((err) => {
        (appLog ?? log).warn({ err }, 'Tenant log retention failed');
      });
    }, delay);
  })();

  // Safety net / DST: hourly check so we still run once on the evening hour
  hourlyTimer = setInterval(() => {
    void maybeRunEvening(appLog).catch((err) => {
      (appLog ?? log).warn({ err }, 'Tenant log retention failed');
    });
  }, 60 * 60 * 1000);
}

export function stopLogRetentionMonitor(): void {
  if (eveningTimer) {
    clearTimeout(eveningTimer);
    eveningTimer = null;
  }
  if (hourlyTimer) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
}

/** Test helper */
export function resetLogRetentionMonitorForTests(): void {
  stopLogRetentionMonitor();
  lastRunDayKey = '';
}
