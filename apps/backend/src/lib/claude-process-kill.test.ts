import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PID_STILL_ALIVE_MS,
  claudeCliSpawnOptions,
  isPidAlive,
  killClaudeProcessGroup,
  scheduleClaudePidAliveLog,
} from './claude-process-kill.js';

describe('isPidAlive', () => {
  it('uses kill(pid, 0) and treats ESRCH as dead', () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 7) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
    expect(isPidAlive(3, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(3, 0);
    expect(isPidAlive(7, kill)).toBe(false);
    expect(isPidAlive(0, kill)).toBe(false);
  });
});

describe('killClaudeProcessGroup', () => {
  it('sends SIGKILL to the process group (-pid)', () => {
    const kill = vi.fn(() => true);
    const childKill = vi.fn();
    expect(killClaudeProcessGroup(4242, { kill, childKill })).toEqual({ triedGroup: true });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(childKill).not.toHaveBeenCalled();
  });

  it('falls back to pid then childKill when group kill fails', () => {
    const kill = vi.fn((target: number) => {
      if (target < 0) throw new Error('ESRCH');
      return true;
    });
    const childKill = vi.fn();
    expect(killClaudeProcessGroup(99, { kill, childKill })).toEqual({ triedGroup: false });
    expect(kill).toHaveBeenCalledWith(-99, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(99, 'SIGKILL');
    expect(childKill).not.toHaveBeenCalled();
  });

  it('uses childKill when pid is missing', () => {
    const childKill = vi.fn();
    expect(killClaudeProcessGroup(undefined, { childKill })).toEqual({ triedGroup: false });
    expect(childKill).toHaveBeenCalled();
  });
});

describe('scheduleClaudePidAliveLog', () => {
  it('logs only when the pid is still alive after the delay', () => {
    vi.useFakeTimers();
    const logWarn = vi.fn();
    const isAlive = vi.fn(() => true);
    scheduleClaudePidAliveLog(11, { reason: 'timeout', logWarn, isAlive });
    expect(logWarn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CLAUDE_PID_STILL_ALIVE_MS);
    expect(isAlive).toHaveBeenCalledWith(11);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'claude_pid_still_alive', pid: 11, reason: 'timeout' }),
      'Claude pid still alive after process-group kill',
    );
    vi.useRealTimers();
  });

  it('does not log when the pid has exited', () => {
    vi.useFakeTimers();
    const logWarn = vi.fn();
    scheduleClaudePidAliveLog(11, { reason: 'abort', logWarn, isAlive: () => false });
    vi.advanceTimersByTime(CLAUDE_PID_STILL_ALIVE_MS);
    expect(logWarn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('claudeCliSpawnOptions', () => {
  it('pipes stdio and detaches a process group on POSIX', () => {
    const opts = claudeCliSpawnOptions('/tmp/claude-spawn');
    expect(opts.cwd).toBe('/tmp/claude-spawn');
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.detached).toBe(process.platform !== 'win32');
  });
});
