/**
 * Append-only audit log of every BeautyPro / AI Helps HTTP call.
 * Path: $TENANT_KNOWLEDGE_DIR/logs/beautypro-api.jsonl
 * Pull from server → rebuild vendor report with exact method + datetime.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pino from 'pino';
import { getBeautyproApiAuditLogPath } from '../../lib/paths.js';
import { DEFAULT_TENANT_TIMEZONE } from '../../lib/tenant-timezone.js';

const log = pino({ name: 'crm:beautypro-audit' });

const REDACT_QUERY_KEYS = new Set([
  'application_secret',
  'refresh_token',
  'access_token',
  'token',
]);

export type BeautyproApiAuditEntry = {
  /** UTC ISO-8601 */
  at: string;
  /** Local civil time in tenant timezone (for human reports) */
  atLocal: string;
  timeZone: string;
  method: string;
  /** Path without host, e.g. /appointments */
  path: string;
  /** Query without secrets */
  query?: Record<string, string>;
  /** Compact body (secrets redacted) */
  body?: unknown;
  httpStatus?: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** api host used (api / api4 / auth) */
  host?: string;
};

let dirReady: Promise<void> | null = null;
let warnedWriteError = false;

function ensureLogDir(filePath: string): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(dirname(filePath), { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

/** Civil datetime in tenant TZ, e.g. 2026-09-07 16:15:22 */
export function formatLocalAuditTime(
  date: Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function redactQuery(
  query: Record<string, string | number | boolean | undefined> | undefined,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  let any = false;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    any = true;
    out[k] = REDACT_QUERY_KEYS.has(k) ? '[redacted]' : String(v);
  }
  return any ? out : undefined;
}

export function summarizeAuditBody(body: unknown): unknown {
  if (body == null) return undefined;
  if (typeof body !== 'object') return body;
  if (Array.isArray(body)) {
    return { _arrayLength: body.length };
  }
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (REDACT_QUERY_KEYS.has(k) || /secret|password|token/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (k === 'services' && Array.isArray(v)) {
      out.services = v.map((row) => {
        if (!row || typeof row !== 'object') return row;
        const r = row as Record<string, unknown>;
        return {
          id: r.id,
          service: r.service,
          professional: r.professional,
          start: r.start,
          duration: r.duration,
          action: r.action,
        };
      });
      continue;
    }
    if (typeof v === 'string' && v.length > 120) {
      out[k] = `${v.slice(0, 120)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Fire-and-forget append one NDJSON line. Never throws to callers.
 */
export function recordBeautyproApiCall(
  entry: Omit<BeautyproApiAuditEntry, 'at' | 'atLocal' | 'timeZone'> & {
    at?: string;
    atLocal?: string;
    timeZone?: string;
  },
): void {
  const now = new Date();
  const timeZone = entry.timeZone ?? DEFAULT_TENANT_TIMEZONE;
  const full: BeautyproApiAuditEntry = {
    at: entry.at ?? now.toISOString(),
    atLocal: entry.atLocal ?? formatLocalAuditTime(now, timeZone),
    timeZone,
    method: entry.method,
    path: entry.path,
    query: entry.query,
    body: entry.body,
    httpStatus: entry.httpStatus,
    ok: entry.ok,
    durationMs: entry.durationMs,
    error: entry.error,
    host: entry.host,
  };

  const filePath = getBeautyproApiAuditLogPath();
  const line = `${JSON.stringify(full)}\n`;

  void (async () => {
    try {
      await ensureLogDir(filePath);
      await appendFile(filePath, line, 'utf8');
    } catch (err) {
      if (!warnedWriteError) {
        warnedWriteError = true;
        log.warn({ err, filePath }, 'BeautyPro API audit log write failed');
      }
    }
  })();
}

/** Reset dir cache (tests). */
export function resetBeautyproApiAuditForTests(): void {
  dirReady = null;
  warnedWriteError = false;
}
