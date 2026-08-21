/**
 * Detect leaked `claude` CLI processes (ppid 1) without crashing health-check.
 */

export interface ClaudeProcessRow {
  pid: number;
  ppid: number;
  args: string;
}

export function parsePsProcessRows(stdout: string): ClaudeProcessRow[] {
  const rows: ClaudeProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      args: match[3] ?? '',
    });
  }
  return rows;
}

/** True when `args` is the Claude Code CLI binary (not node with "claude" in cwd). */
export function isClaudeCliCommand(args: string, binaryPath: string): boolean {
  const trimmed = args.trim();
  if (!trimmed) return false;
  if (binaryPath && trimmed.includes(binaryPath)) return true;
  const first = trimmed.split(/\s+/)[0] ?? '';
  return first === 'claude' || first.endsWith('/claude');
}

/**
 * Orphans: Claude CLI whose parent is init (typical after a missed group kill).
 * In-flight children of this Node process are excluded (ppid === selfPid).
 */
export function findOrphanClaudeProcesses(
  rows: ClaudeProcessRow[],
  opts: { binaryPath: string; selfPid: number },
): ClaudeProcessRow[] {
  return rows.filter(
    (row) =>
      row.pid !== opts.selfPid &&
      isClaudeCliCommand(row.args, opts.binaryPath) &&
      (row.ppid === 1 || row.ppid === 0),
  );
}
