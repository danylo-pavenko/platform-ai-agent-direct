/**
 * Kill a Claude CLI process group and log leftovers.
 *
 * Spawn uses `detached: true` so the child is a group leader; `kill(-pid)`
 * reaps MCP grandchildren. `kill(-pid)` is a PGID, not “parent of pid” —
 * if the child is not a leader it ESRCH and we fall back to a single pid.
 */

import type { SpawnOptions } from 'node:child_process';

export const CLAUDE_PID_STILL_ALIVE_MS = 2_000;

/** POSIX: new process group so abort can reap MCP grandchildren. Do not unref. */
export function claudeCliSpawnOptions(cwd: string): SpawnOptions {
  return {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    cwd,
    detached: process.platform !== 'win32',
  };
}

export type ProcessKillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export function isPidAlive(
  pid: number,
  killFn: ProcessKillFn = (target, signal) => process.kill(target, signal),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killClaudeProcessGroup(
  pid: number | undefined | null,
  deps: {
    kill?: ProcessKillFn;
    childKill?: () => void;
  } = {},
): { triedGroup: boolean } {
  const kill: ProcessKillFn =
    deps.kill ?? ((target, signal) => process.kill(target, signal));

  if (pid && pid > 0) {
    try {
      kill(-pid, 'SIGKILL');
      return { triedGroup: true };
    } catch {
      try {
        kill(pid, 'SIGKILL');
        return { triedGroup: false };
      } catch {
        /* already gone */
      }
    }
  }

  try {
    deps.childKill?.();
  } catch {
    /* ignore */
  }
  return { triedGroup: false };
}

export function scheduleClaudePidAliveLog(
  pid: number,
  opts: {
    reason: string;
    delayMs?: number;
    isAlive?: (pid: number) => boolean;
    logWarn?: (payload: Record<string, unknown>, msg: string) => void;
    setTimeoutFn?: typeof setTimeout;
  },
): ReturnType<typeof setTimeout> {
  const delayMs = opts.delayMs ?? CLAUDE_PID_STILL_ALIVE_MS;
  const alive = opts.isAlive ?? isPidAlive;
  const handle = (opts.setTimeoutFn ?? setTimeout)(() => {
    if (!alive(pid)) return;
    opts.logWarn?.(
      { event: 'claude_pid_still_alive', pid, reason: opts.reason, afterMs: delayMs },
      'Claude pid still alive after process-group kill',
    );
  }, delayMs);
  handle.unref?.();
  return handle;
}
