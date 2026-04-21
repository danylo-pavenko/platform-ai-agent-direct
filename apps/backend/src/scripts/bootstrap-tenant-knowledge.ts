/**
 * bootstrap-tenant-knowledge.ts
 *
 * Seeds TENANT_KNOWLEDGE_DIR (default $HOME/tenant_knowledge) from the
 * templates shipped in the repo. Runs as part of deploy-client.sh on
 * every deploy; safe to invoke manually at any time:
 *
 *   npm run bootstrap:knowledge
 *
 * Semantics:
 *   - Recursively walks apps/workspace/templates/**
 *   - For each template file, computes its counterpart under the
 *     tenant dir.
 *   - If the destination does NOT exist → copy (create parent dirs).
 *   - If the destination already exists → skip, never overwrite.
 *
 * This guarantees that after first deploy the tenant has a sane
 * default, and that subsequent deploys never clobber customer edits.
 */

import '../config.js';

import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import pino from 'pino';

import { TEMPLATES_DIR, getTenantKnowledgeDir } from '../lib/paths.js';

const log = pino({ name: 'bootstrap-tenant-knowledge' });

interface Result {
  copied: string[];
  skipped: string[];
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function bootstrap(): Promise<Result> {
  const tenantDir = getTenantKnowledgeDir();

  if (!existsSync(TEMPLATES_DIR)) {
    throw new Error(`Templates directory missing: ${TEMPLATES_DIR}`);
  }

  const templateFiles = await walk(TEMPLATES_DIR);

  const result: Result = { copied: [], skipped: [] };

  for (const src of templateFiles) {
    const rel = relative(TEMPLATES_DIR, src);

    // Skip the README — it describes the template system, not content
    // that should ship into a tenant dir.
    if (rel === 'README.md') continue;

    const dest = join(tenantDir, rel);

    if (existsSync(dest)) {
      result.skipped.push(rel);
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    result.copied.push(rel);
  }

  return result;
}

async function main() {
  const tenantDir = getTenantKnowledgeDir();
  log.info({ templatesDir: TEMPLATES_DIR, tenantDir }, 'Bootstrap starting');

  try {
    await mkdir(tenantDir, { recursive: true });
    const { copied, skipped } = await bootstrap();

    if (copied.length > 0) {
      log.info({ files: copied }, `Copied ${copied.length} file(s) to ${tenantDir}`);
    }
    if (skipped.length > 0) {
      log.info({ count: skipped.length }, 'Skipped (already exists) — tenant edits preserved');
    }
    log.info('Bootstrap complete');
  } catch (err) {
    log.error({ err }, 'Bootstrap failed');
    process.exit(1);
  }
}

void main();
