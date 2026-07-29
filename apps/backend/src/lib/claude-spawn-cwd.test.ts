import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

vi.mock('../config.js', () => ({
  config: {
    INSTANCE_ID: 'tkp',
    TENANT_KNOWLEDGE_DIR: '/home/tkp/tenant_knowledge',
  },
}));

import { resolveClaudeSpawnCwd } from './claude-spawn-cwd.js';
import { getTenantKnowledgeDir } from './paths.js';

describe('resolveClaudeSpawnCwd', () => {
  it('lives under ~/.cache, not under tenant_knowledge (avoids parent CLAUDE.md walk)', () => {
    const cwd = resolveClaudeSpawnCwd();
    const tenant = getTenantKnowledgeDir();
    expect(cwd.startsWith(tenant)).toBe(false);
    expect(cwd.includes('tenant_knowledge')).toBe(false);
    expect(cwd).toBe(
      resolvePath(homedir(), '.cache', 'platform-ai-agent', 'tkp', 'claude-spawn'),
    );
  });
});
