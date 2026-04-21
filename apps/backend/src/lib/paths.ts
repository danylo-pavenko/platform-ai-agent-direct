/**
 * paths.ts — Canonical filesystem paths for this tenant.
 *
 * All tenant-specific, editable content (prompts, knowledge, generated
 * catalog) lives in one directory OUTSIDE the repository, so each Linux
 * user hosting a tenant accumulates its own knowledge independently.
 *
 * Default: $HOME/tenant_knowledge
 * Override: set TENANT_KNOWLEDGE_DIR in .env
 *
 * Example for a tenant running as the `blessed` Linux user:
 *   /home/blessed/tenant_knowledge/
 *   ├── prompts/sales-agent.txt
 *   └── knowledge/{brand,contacts,delivery,faq,categories,catalog}.txt
 */

import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo root (…/platform-ai-agent-direct). */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Seed templates shipped with the repo. Read-only at runtime. */
export const TEMPLATES_DIR = resolve(
  REPO_ROOT,
  'apps',
  'workspace',
  'templates',
);

/**
 * Resolved tenant knowledge directory. Uses TENANT_KNOWLEDGE_DIR when
 * set, otherwise falls back to $HOME/tenant_knowledge.
 */
export function getTenantKnowledgeDir(): string {
  if (config.TENANT_KNOWLEDGE_DIR) return config.TENANT_KNOWLEDGE_DIR;
  return resolve(homedir(), 'tenant_knowledge');
}

/** Shortcut: catalog.txt path inside the tenant knowledge dir. */
export function getCatalogPath(): string {
  return resolve(getTenantKnowledgeDir(), 'knowledge', 'catalog.txt');
}

/** Shortcut: sales-agent.txt path inside the tenant knowledge dir. */
export function getSalesAgentPromptPath(): string {
  return resolve(getTenantKnowledgeDir(), 'prompts', 'sales-agent.txt');
}

/** Shortcut: the corresponding template path (used by seed / bootstrap). */
export function getSalesAgentTemplatePath(): string {
  return resolve(TEMPLATES_DIR, 'prompts', 'sales-agent.txt');
}
