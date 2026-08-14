/**
 * Claude Code subscription usage — parsed from `claude -p '/usage'`.
 * Pro/Max/Team plans expose rolling window percentages (session + weekly buckets).
 *
 * Format notes (Claude Code ≥2.1.x):
 * - Bucket lines: `Label: N% used` with optional ` · resets <when>`
 * - Session at 0% often omits the resets suffix
 * - Model-specific week buckets may be named Sonnet / Opus / Fable / etc.
 * - JSON stdout from `--output-format json` wraps text in `{ type: "result", result: "..." }`
 *   (may be preceded by non-JSON warning lines)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { getClaudeBinaryPath } from '../lib/claude-binary.js';
import { resolveClaudeSpawnCwd } from '../lib/claude-spawn-cwd.js';

const execFileAsync = promisify(execFile);
const log = pino({ name: 'claude-usage' });

/** Default warning threshold when config is not injected (unit tests / parse-only). */
export const DEFAULT_USAGE_WARNING_PERCENT = 90;

export type ClaudeUsageStatus = 'ok' | 'warning' | 'exhausted' | 'unavailable';

/** Prefer live truth over ancient ~/.claude.json utilization. */
export const CLAUDE_USAGE_CACHE_STALE_MS = 2 * 60 * 60 * 1000;

export interface ClaudeUsageBucket {
  id: string;
  label: string;
  percentUsed: number;
  resetsAt: string;
}

export interface ClaudeUsageSnapshot {
  checkedAt: string;
  status: ClaudeUsageStatus;
  subscriptionType: string | null;
  authEmail: string | null;
  buckets: ClaudeUsageBucket[];
  worstPercent: number;
  message: string;
  rawText: string | null;
  error: string | null;
  /** When snapshot came from Claude Code local cache (`fetchedAtMs`). */
  cacheFetchedAt?: string | null;
  /** True when cache is older than CLAUDE_USAGE_CACHE_STALE_MS — bars may disagree with live 429. */
  cacheStale?: boolean;
}

export const CLAUDE_USAGE_SNAPSHOT_KEY = 'claude_usage_snapshot';
export const CLAUDE_USAGE_NOTIFY_KEY = 'claude_usage_notify_state';

/**
 * Match plan-limit bucket lines from `/usage` text.
 * Resets clause is optional (session at 0% often has none).
 * Accept middle-dot / bullet / dash separators before "resets".
 */
const BUCKET_LINE_RE =
  /^([^\n:]+):\s*(\d+)\s*%\s+used(?:\s*(?:[·•|\-–,]+)\s*resets?\s+(.+))?$/gim;

function slugifyBucketLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64) || 'bucket';
}

/** True for plan-limit labels; skip activity breakdown lines. */
function isPlanLimitBucketLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  if (!l) return false;
  // Activity / breakdown sections — not rolling plan windows
  if (l.startsWith('top ')) return false;
  if (l.startsWith('last ')) return false;
  if (l.includes('contributing')) return false;
  // Known / typical plan windows
  if (l.startsWith('current session')) return true;
  if (l.startsWith('current week')) return true;
  if (l.includes('session')) return true;
  if (l.includes('week')) return true;
  if (l.includes('limit')) return true;
  // Extra usage / credits bars if present
  if (l.includes('extra')) return true;
  return false;
}

function formatResetsAt(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.trim();
  try {
    return d.toLocaleString('uk-UA', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return raw.trim();
  }
}

function labelForCachedLimit(limit: {
  kind?: unknown;
  group?: unknown;
  scope?: unknown;
}): string {
  const kind = typeof limit.kind === 'string' ? limit.kind : '';
  const group = typeof limit.group === 'string' ? limit.group : '';
  let modelName: string | null = null;
  if (limit.scope && typeof limit.scope === 'object' && !Array.isArray(limit.scope)) {
    const scope = limit.scope as Record<string, unknown>;
    const model = scope.model;
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      const display = (model as Record<string, unknown>).display_name;
      if (typeof display === 'string' && display.trim()) modelName = display.trim();
    }
  }

  if (kind === 'session' || group === 'session') return 'Current session';
  if (kind === 'weekly_all' || (group === 'weekly' && !modelName)) {
    return 'Current week (all models)';
  }
  if (kind === 'weekly_scoped' || modelName) {
    return `Current week (${modelName ?? 'scoped'})`;
  }
  if (kind) return kind.replace(/_/g, ' ');
  if (group) return group;
  return 'Limit';
}

/**
 * Parse Claude Code's local `cachedUsageUtilization` from `~/.claude.json`.
 * This is the same cache the CLI writes after subscription rate-limit responses —
 * modern `claude -p /usage` often omits `% used` lines and only prints a breakdown.
 */
export function parseCachedUsageUtilization(
  cached: unknown,
  warningAt: number = DEFAULT_USAGE_WARNING_PERCENT,
): (Omit<ClaudeUsageSnapshot, 'checkedAt' | 'subscriptionType' | 'authEmail'> & {
  fetchedAtMs: number | null;
}) | null {
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null;
  const root = cached as Record<string, unknown>;
  const fetchedAtMs = typeof root.fetchedAtMs === 'number' ? root.fetchedAtMs : null;
  const utilization = root.utilization;
  if (!utilization || typeof utilization !== 'object' || Array.isArray(utilization)) {
    return null;
  }
  const util = utilization as Record<string, unknown>;
  const buckets: ClaudeUsageBucket[] = [];
  const seen = new Set<string>();

  const limits = Array.isArray(util.limits) ? util.limits : [];
  for (const item of limits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const limit = item as Record<string, unknown>;
    const percentRaw = limit.percent;
    const percentUsed =
      typeof percentRaw === 'number'
        ? Math.round(percentRaw)
        : typeof percentRaw === 'string'
          ? Number.parseInt(percentRaw, 10)
          : NaN;
    if (!Number.isFinite(percentUsed)) continue;

    const label = labelForCachedLimit(limit);
    const id = slugifyBucketLabel(label);
    if (seen.has(id)) continue;
    seen.add(id);

    buckets.push({
      id,
      label,
      percentUsed,
      resetsAt: formatResetsAt(typeof limit.resets_at === 'string' ? limit.resets_at : null),
    });
  }

  // Fallback to five_hour / seven_day windows when `limits[]` is empty.
  if (buckets.length === 0) {
    const windows: Array<{ id: string; label: string; key: string }> = [
      { id: 'current_session', label: 'Current session', key: 'five_hour' },
      { id: 'current_week_all_models', label: 'Current week (all models)', key: 'seven_day' },
    ];
    for (const w of windows) {
      const win = util[w.key];
      if (!win || typeof win !== 'object' || Array.isArray(win)) continue;
      const rec = win as Record<string, unknown>;
      const u = rec.utilization;
      const percentUsed = typeof u === 'number' ? Math.round(u) : NaN;
      if (!Number.isFinite(percentUsed)) continue;
      buckets.push({
        id: w.id,
        label: w.label,
        percentUsed,
        resetsAt: formatResetsAt(typeof rec.resets_at === 'string' ? rec.resets_at : null),
      });
    }
  }

  if (buckets.length === 0) return null;

  const worstPercent = Math.max(...buckets.map((b) => b.percentUsed));
  let status: ClaudeUsageStatus = 'ok';
  if (worstPercent >= 100) status = 'exhausted';
  else if (worstPercent >= warningAt) status = 'warning';

  const ageNote =
    fetchedAtMs != null
      ? ` (кеш Claude Code, ${formatResetsAt(new Date(fetchedAtMs).toISOString())})`
      : ' (кеш Claude Code)';

  const cacheAgeMs = fetchedAtMs != null ? Date.now() - fetchedAtMs : null;
  const cacheStale =
    cacheAgeMs != null && cacheAgeMs > CLAUDE_USAGE_CACHE_STALE_MS;

  // Stale cache must not show green "OK" — live session (5h) 429 can disagree.
  let message = `${buildUsageMessage(status, buckets, worstPercent, warningAt)}${ageNote}`;
  if (cacheStale) {
    status = 'unavailable';
    message =
      `Кеш лімітів Claude Code застарів${ageNote}. ` +
      `Відсотки нижче можуть не збігатися з live session limit (429 «You've hit your session limit»). ` +
      `«Оновити зараз» лише перечитує той самий файл — дані оновлює Claude Code після rate-limit відповідей.`;
  }

  return {
    status,
    buckets,
    worstPercent,
    message,
    rawText: null,
    error: null,
    fetchedAtMs,
    cacheStale,
  };
}

/** Read ~/.claude.json → cachedUsageUtilization (no network / no CLI). */
export function readCachedUsageFromClaudeJson(
  warningAt: number = DEFAULT_USAGE_WARNING_PERCENT,
): ReturnType<typeof parseCachedUsageUtilization> {
  const path = resolvePath(homedir(), '.claude.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return parseCachedUsageUtilization(obj.cachedUsageUtilization, warningAt);
  } catch (err) {
    log.debug({ err, path }, 'Claude cachedUsageUtilization unavailable');
    return null;
  }
}

/** Parse the plain-text block returned by `/usage`. */
export function parseClaudeUsageText(
  text: string,
  warningAt: number = DEFAULT_USAGE_WARNING_PERCENT,
): Omit<ClaudeUsageSnapshot, 'checkedAt' | 'subscriptionType' | 'authEmail'> {
  const rawText = text.trim();
  const buckets: ClaudeUsageBucket[] = [];
  const seen = new Set<string>();

  for (const match of rawText.matchAll(BUCKET_LINE_RE)) {
    const label = match[1].trim();
    if (!isPlanLimitBucketLabel(label)) continue;

    const percentUsed = Number.parseInt(match[2], 10);
    const resetsAt = (match[3] ?? '').trim() || '—';
    if (!Number.isFinite(percentUsed)) continue;

    const id = slugifyBucketLabel(label);
    if (seen.has(id)) continue;
    seen.add(id);

    buckets.push({
      id,
      label,
      percentUsed,
      resetsAt,
    });
  }

  const worstPercent = buckets.length > 0
    ? Math.max(...buckets.map((b) => b.percentUsed))
    : 0;

  let status: ClaudeUsageStatus = 'ok';
  if (buckets.length === 0) {
    status = 'unavailable';
  } else if (worstPercent >= 100) {
    status = 'exhausted';
  } else if (worstPercent >= warningAt) {
    status = 'warning';
  }

  const message = buildUsageMessage(status, buckets, worstPercent, warningAt);

  return {
    status,
    buckets,
    worstPercent,
    message,
    rawText: rawText || null,
    error: buckets.length === 0 ? 'Не вдалося розпарсити ліміти з /usage' : null,
  };
}

function buildUsageMessage(
  status: ClaudeUsageStatus,
  buckets: ClaudeUsageBucket[],
  worstPercent: number,
  warningAt: number,
): string {
  if (status === 'unavailable') {
    return 'Ліміти Claude недоступні (перевірте claude auth login на сервері).';
  }

  const worst = buckets.find((b) => b.percentUsed === worstPercent) ?? buckets[0];
  if (status === 'exhausted') {
    return `Ліміт Claude вичерпано: ${worst.label} — ${worst.percentUsed}% (скинеться ${worst.resetsAt}).`;
  }
  if (status === 'warning') {
    return `Ліміт Claude майже вичерпано (≥${warningAt}%): ${worst.label} — ${worst.percentUsed}% (скинеться ${worst.resetsAt}).`;
  }

  const top = [...buckets].sort((a, b) => b.percentUsed - a.percentUsed)[0];
  return top
    ? `Ліміти Claude в нормі. Найбільше завантаження: ${top.label} — ${top.percentUsed}%.`
    : 'Ліміти Claude в нормі.';
}

/** Extract the human `/usage` text from `claude -p --output-format json` stdout. */
export function parseUsageJsonStdout(stdout: string): string | null {
  // Prefer line-by-line (common: warning lines + one JSON object per line).
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const fromLine = tryExtractUsageResult(trimmed);
    if (fromLine) return fromLine;
  }

  // Fallback: JSON may be pretty-printed or preceded by non-JSON noise.
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  return tryExtractUsageResult(stdout.slice(start));
}

function tryExtractUsageResult(jsonText: string): string | null {
  try {
    const obj = JSON.parse(jsonText) as {
      type?: string;
      subtype?: string;
      result?: unknown;
      is_error?: boolean;
    };
    if (obj.is_error === true) return null;
    if (typeof obj.result !== 'string' || !obj.result.trim()) return null;
    // Accept classic `{ type: "result" }` and newer envelopes that still carry `result`.
    if (obj.type === 'result' || obj.subtype === 'success' || obj.type == null) {
      return obj.result;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchClaudeUsageText(
  timeoutMs = config.CLAUDE_USAGE_TIMEOUT_MS,
): Promise<string> {
  const binary = getClaudeBinaryPath();
  // Haiku + max-turns 1: usage is not a coding task; keep cold-start cost down.
  const args = [
    '-p',
    '/usage',
    '--output-format',
    'json',
    '--model',
    'haiku',
    '--max-turns',
    '1',
  ];
  const cwd = resolveClaudeSpawnCwd();

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude /usage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const parsed = parseUsageJsonStdout(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }

      // Last resort: plain-text stdout (some CLI versions skip JSON wrapper).
      if (code === 0 && /\d+\s*%\s+used/i.test(stdout)) {
        resolve(stdout);
        return;
      }

      const detail = stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300);
      reject(
        new Error(
          code === 0
            ? 'claude /usage returned no parseable result'
            : `claude /usage exit ${code}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });
}

async function fetchClaudeAuthMeta(): Promise<{
  loggedIn: boolean;
  subscriptionType: string | null;
  authEmail: string | null;
}> {
  try {
    const { stdout } = await execFileAsync(getClaudeBinaryPath(), ['auth', 'status'], {
      timeout: 8000,
      env: { ...process.env },
      maxBuffer: 64 * 1024,
    });
    const obj = JSON.parse(stdout.trim()) as {
      subscriptionType?: string;
      email?: string;
      loggedIn?: boolean;
    };
    const loggedIn = obj.loggedIn === true;
    return {
      loggedIn,
      subscriptionType:
        loggedIn && typeof obj.subscriptionType === 'string' ? obj.subscriptionType : null,
      authEmail: loggedIn && typeof obj.email === 'string' ? obj.email : null,
    };
  } catch (err) {
    log.debug({ err }, 'claude auth status unavailable');
    return { loggedIn: false, subscriptionType: null, authEmail: null };
  }
}

type ClaudeAuthMeta = Awaited<ReturnType<typeof fetchClaudeAuthMeta>>;

type CachedUsageParsed = NonNullable<ReturnType<typeof parseCachedUsageUtilization>>;

function snapshotFromCachedUtilization(
  fromCache: CachedUsageParsed,
  checkedAt: string,
  auth: ClaudeAuthMeta,
): ClaudeUsageSnapshot {
  const { fetchedAtMs, ...snap } = fromCache;
  return {
    checkedAt,
    subscriptionType: auth.subscriptionType,
    authEmail: auth.authEmail,
    ...snap,
    cacheFetchedAt: fetchedAtMs != null ? new Date(fetchedAtMs).toISOString() : null,
    cacheStale: snap.cacheStale === true,
  };
}

export type FetchClaudeUsageOptions = {
  /**
   * Spawn `claude -p /usage` (haiku, 1 turn) so Claude Code refreshes
   * `cachedUsageUtilization` in ~/.claude.json. Used by the 30-min monitor
   * and Settings → «Оновити зараз».
   */
  forceLive?: boolean;
};

/**
 * Build a usage snapshot for admin / monitor.
 *
 * - Default: prefer fresh local cache (cheap).
 * - `forceLive` or stale/missing cache: spawn `/usage`, then re-read cache.
 */
export async function fetchClaudeUsageSnapshot(
  opts: FetchClaudeUsageOptions = {},
): Promise<ClaudeUsageSnapshot> {
  const checkedAt = new Date().toISOString();
  const warningAt = config.CLAUDE_USAGE_WARNING_PERCENT;

  try {
    // Cheap gate: do not spawn `claude -p /usage` when there is no session.
    const auth = await fetchClaudeAuthMeta();
    if (!auth.loggedIn) {
      return {
        checkedAt,
        status: 'unavailable',
        subscriptionType: null,
        authEmail: null,
        buckets: [],
        worstPercent: 0,
        message:
          'Claude ще не авторизовано — спочатку увійдіть у Налаштування → Claude.',
        rawText: null,
        error: 'not_authenticated',
        cacheFetchedAt: null,
        cacheStale: false,
      };
    }

    const cachedBefore = readCachedUsageFromClaudeJson(warningAt);
    const needLive =
      opts.forceLive === true || !cachedBefore || cachedBefore.cacheStale === true;

    if (!needLive && cachedBefore) {
      return snapshotFromCachedUtilization(cachedBefore, checkedAt, auth);
    }

    // Live refresh: haiku /usage nudges Claude Code to rewrite utilization cache.
    try {
      log.info(
        { forceLive: opts.forceLive === true, hadCache: Boolean(cachedBefore) },
        'Refreshing Claude usage via claude -p /usage',
      );
      const usageText = await fetchClaudeUsageText();
      const parsed = parseClaudeUsageText(usageText, warningAt);
      if (parsed.buckets.length > 0) {
        return {
          checkedAt,
          subscriptionType: auth.subscriptionType,
          authEmail: auth.authEmail,
          ...parsed,
          cacheFetchedAt: checkedAt,
          cacheStale: false,
        };
      }

      // Modern CLI often prints breakdown without "% used" but still refreshes ~/.claude.json.
      const refreshed = readCachedUsageFromClaudeJson(warningAt);
      if (refreshed) {
        return snapshotFromCachedUtilization(refreshed, checkedAt, auth);
      }

      return {
        checkedAt,
        status: 'unavailable',
        subscriptionType: auth.subscriptionType,
        authEmail: auth.authEmail,
        buckets: [],
        worstPercent: 0,
        message:
          parsed.error ??
          'Ліміти Claude недоступні (немає кешу в ~/.claude.json і /usage без % used).',
        rawText: parsed.rawText,
        error: parsed.error ?? 'no_usage_data',
        cacheFetchedAt: null,
        cacheStale: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, message }, 'claude /usage CLI failed — falling back to local cache');

      const fallbackCache = readCachedUsageFromClaudeJson(warningAt) ?? cachedBefore;
      if (fallbackCache) {
        const snap = snapshotFromCachedUtilization(fallbackCache, checkedAt, auth);
        return {
          ...snap,
          error: message,
          message: `Live /usage не вдався (${message}). ${snap.message}`,
        };
      }

      return {
        checkedAt,
        status: 'unavailable',
        subscriptionType: auth.subscriptionType,
        authEmail: auth.authEmail,
        buckets: [],
        worstPercent: 0,
        message: `Не вдалося перевірити ліміти Claude: ${message}`,
        rawText: null,
        error: message,
        cacheFetchedAt: null,
        cacheStale: false,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, message }, 'Failed to fetch Claude usage snapshot');
    return {
      checkedAt,
      status: 'unavailable',
      subscriptionType: null,
      authEmail: null,
      buckets: [],
      worstPercent: 0,
      message: `Не вдалося перевірити ліміти Claude: ${message}`,
      rawText: null,
      error: message,
      cacheFetchedAt: null,
      cacheStale: false,
    };
  }
}
