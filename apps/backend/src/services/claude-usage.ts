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
import { promisify } from 'node:util';
import pino from 'pino';
import { getClaudeBinaryPath } from './claude.js';

const execFileAsync = promisify(execFile);
const log = pino({ name: 'claude-usage' });

/** Default warning threshold when config is not injected (unit tests / parse-only). */
export const DEFAULT_USAGE_WARNING_PERCENT = 90;

export type ClaudeUsageStatus = 'ok' | 'warning' | 'exhausted' | 'unavailable';

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

async function fetchClaudeUsageText(timeoutMs = 25_000): Promise<string> {
  const binary = getClaudeBinaryPath();
  const args = ['-p', '/usage', '--output-format', 'json'];

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
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

/** Live fetch from Claude CLI `/usage` command. */
export async function fetchClaudeUsageSnapshot(): Promise<ClaudeUsageSnapshot> {
  const checkedAt = new Date().toISOString();

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
      };
    }

    const usageText = await fetchClaudeUsageText();
    const { config } = await import('../config.js');
    const parsed = parseClaudeUsageText(usageText, config.CLAUDE_USAGE_WARNING_PERCENT);
    return {
      checkedAt,
      subscriptionType: auth.subscriptionType,
      authEmail: auth.authEmail,
      ...parsed,
    };
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
    };
  }
}
