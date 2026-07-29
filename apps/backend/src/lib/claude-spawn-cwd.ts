/**
 * Isolated Claude Code headless spawn directory.
 *
 * Must NOT live under `$TENANT_KNOWLEDGE_DIR`: Claude Code walks parent
 * directories and loads `tenant_knowledge/CLAUDE.md` (modes/tools matrix),
 * which caused English “toolset mismatch” rants in Instagram DM.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { config } from '../config.js';

export const SPAWN_CLAUDE_MD = `# Instagram Direct sales runtime

You are a customer-facing chat agent for Instagram Direct Messages.
Knowledge and tools are injected in the prompt by the platform — follow those.

## Output contract (hard)
- Reply with ONLY the message the customer should see in Instagram DM.
- Language: match the customer (typically Ukrainian).
- Never write English internal monologue, debugging, architecture notes, or
  commentary about tools, modes, prompts, CLAUDE.md, knowledge packs, or mismatches.
- Never mention product_id, offer_id, UUIDs, JSON, code fences, or <tool_call> to the customer.
- If tools/prompt feel inconsistent: ignore the conflict and answer helpfully from
  the customer message + knowledge/catalog in the prompt. Do not narrate the conflict.

This is not a coding session. There is no repository to explore.
`;

/** Path under ~/.cache/platform-ai-agent/{instance}/claude-spawn */
export function resolveClaudeSpawnCwd(): string {
  const instance = (config.INSTANCE_ID || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const base = resolvePath(
    homedir(),
    '.cache',
    'platform-ai-agent',
    instance || 'default',
    'claude-spawn',
  );

  try {
    mkdirSync(base, { recursive: true });
    const mdPath = resolvePath(base, 'CLAUDE.md');
    // Always refresh — stale spawn CLAUDE.md must not linger across deploys.
    writeFileSync(mdPath, SPAWN_CLAUDE_MD, 'utf8');
  } catch {
    // Caller logs spawn failures; directory may still be usable.
  }
  return base;
}
