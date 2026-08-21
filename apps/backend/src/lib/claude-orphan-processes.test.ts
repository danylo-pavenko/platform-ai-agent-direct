import { describe, expect, it } from 'vitest';
import {
  findOrphanClaudeProcesses,
  isClaudeCliCommand,
  parsePsProcessRows,
} from './claude-orphan-processes.js';

const binary = '/home/tenant/.local/bin/claude';

describe('parsePsProcessRows', () => {
  it('parses pid ppid args', () => {
    const rows = parsePsProcessRows(
      '  42  1 /home/tenant/.local/bin/claude -p\n  7  42 node apps/backend\n',
    );
    expect(rows).toEqual([
      { pid: 42, ppid: 1, args: '/home/tenant/.local/bin/claude -p' },
      { pid: 7, ppid: 42, args: 'node apps/backend' },
    ]);
  });
});

describe('isClaudeCliCommand', () => {
  it('matches the tenant binary and a bare claude argv0', () => {
    expect(isClaudeCliCommand(`${binary} -p --model haiku`, binary)).toBe(true);
    expect(isClaudeCliCommand('claude -p', binary)).toBe(true);
    expect(isClaudeCliCommand('/usr/bin/claude auth login', binary)).toBe(true);
  });

  it('does not match node with claude in the cwd or flags', () => {
    expect(
      isClaudeCliCommand('node /app/apps/backend/dist/server.js --claude-runtime sdk', binary),
    ).toBe(false);
  });
});

describe('findOrphanClaudeProcesses', () => {
  it('keeps ppid 1 claude and skips children of this Node process', () => {
    const rows = [
      { pid: 100, ppid: 1, args: `${binary} -p` },
      { pid: 101, ppid: 50, args: `${binary} -p` },
      { pid: 50, ppid: 1, args: 'node server.js' },
    ];
    expect(findOrphanClaudeProcesses(rows, { binaryPath: binary, selfPid: 50 })).toEqual([
      { pid: 100, ppid: 1, args: `${binary} -p` },
    ]);
  });
});
