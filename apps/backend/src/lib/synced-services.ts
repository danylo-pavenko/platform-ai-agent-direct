/**
 * Read the CRM sync snapshot of salon services (data/services.json).
 * Written by sync-worker after a successful services fetch.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrmServiceItem } from '../services/crm/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root — same depth as lib/paths.ts (apps/backend/src/lib → repo). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DATA_DIR = resolve(REPO_ROOT, 'data');

export type SyncedServiceRow = CrmServiceItem & { provider: string };

export function getServicesSnapshotPath(): string {
  return resolve(DATA_DIR, 'services.json');
}

function isSyncedServiceRow(value: unknown): value is SyncedServiceRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.price !== 'number' ||
    typeof row.durationMin !== 'number' ||
    typeof row.provider !== 'string'
  ) {
    return false;
  }
  if (row.priceRows != null) {
    if (!Array.isArray(row.priceRows)) return false;
    for (const pr of row.priceRows) {
      if (!pr || typeof pr !== 'object') return false;
      const p = pr as Record<string, unknown>;
      if (typeof p.branchId !== 'string' || typeof p.price !== 'number') return false;
    }
  }
  return true;
}

/** Parse and validate services.json contents. Invalid rows are skipped. */
export function parseServicesSnapshot(raw: string): SyncedServiceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isSyncedServiceRow);
}

/** Load synced services from disk. Missing/unreadable file → []. */
export async function loadSyncedServices(
  snapshotPath: string = getServicesSnapshotPath(),
): Promise<SyncedServiceRow[]> {
  try {
    const raw = await readFile(snapshotPath, 'utf8');
    return parseServicesSnapshot(raw);
  } catch {
    return [];
  }
}
