/**
 * Path to the Claude Code CLI binary used by agent + usage checks.
 * Kept tiny so services can import it without loading the full claude.ts module.
 */
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

export function getClaudeBinaryPath(): string {
  return resolvePath(homedir(), '.local', 'bin', 'claude');
}
