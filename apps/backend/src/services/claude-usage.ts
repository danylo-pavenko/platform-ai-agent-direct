/**
 * Claude Code subscription usage — parsed from `claude -p '/usage'`.
 * Pro/Max plans expose rolling window percentages (session + weekly buckets).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config.js';
import { getClaudeBinaryPath } from './claude.js';

const execFileAsync = promisify(execFile);
const log = pino({ name: 'claude-usage' });

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

const BUCKET_LINE_RE =
  /^(.+?):\s*(\d+)%\s+used\s*·\s*resets\s+(.+)$/gm;

function slugifyBucketLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64) || 'bucket';
}

/** Parse the plain-text block returned by `/usage`. */
export function parseClaudeUsageText(text: string): Omit<ClaudeUsageSnapshot, 'checkedAt' | 'subscriptionType' | 'authEmail'> {
  const rawText = text.trim();
  const buckets: ClaudeUsageBucket[] = [];

  for (const match of rawText.matchAll(BUCKET_LINE_RE)) {
    const label = match[1].trim();
    const percentUsed = Number.parseInt(match[2], 10);
    const resetsAt = match[3].trim();
    if (!Number.isFinite(percentUsed)) continue;
    buckets.push({
      id: slugifyBucketLabel(label),
      label,
      percentUsed,
      resetsAt,
    });
  }

  const worstPercent = buckets.length > 0
    ? Math.max(...buckets.map((b) => b.percentUsed))
    : 0;

  const warningAt = config.CLAUDE_USAGE_WARNING_PERCENT;
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

function parseUsageJsonStdout(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; result?: string };
      if (obj.type === 'result' && typeof obj.result === 'string') {
        return obj.result;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return null;
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
    const parsed = parseClaudeUsageText(usageText);
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
