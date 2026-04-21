/**
 * crm-field-mappings.ts
 *
 * In-memory TTL cache for the CrmFieldMapping table. Mappings are read
 * on *every* inbound message (to build the dynamic tool schema + prompt
 * section), so a DB round-trip per hit would regress p50 latency.
 *
 * The cache keeps a shaped snapshot:
 *   - all          → full list of active mappings
 *   - buyer / order → pre-split by scope (most callers need only one)
 *   - byLocalKey   → O(1) lookup when converting extracted slug → CRM uuid
 *
 * Same 60s TTL as integration-config — short enough that admin edits
 * propagate quickly on their own, but long enough to be effectively
 * zero-cost on hot paths. Callers that *mutate* mappings (admin CRUD
 * routes) must call invalidateCrmFieldMappingsCache() after write.
 */

import type { CrmFieldMapping } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';

export interface CrmFieldMappingsSnapshot {
  all: CrmFieldMapping[];
  buyer: CrmFieldMapping[];
  order: CrmFieldMapping[];
  byLocalKey: Map<string, CrmFieldMapping>;
}

let _cache: CrmFieldMappingsSnapshot | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

const EMPTY: CrmFieldMappingsSnapshot = {
  all: [],
  buyer: [],
  order: [],
  byLocalKey: new Map(),
};

export async function getActiveCrmFieldMappings(): Promise<CrmFieldMappingsSnapshot> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const rows = await prisma.crmFieldMapping.findMany({
    where: { isActive: true },
    orderBy: { label: 'asc' },
  });

  if (rows.length === 0) {
    _cache = EMPTY;
    _cacheAt = Date.now();
    return _cache;
  }

  const buyer: CrmFieldMapping[] = [];
  const order: CrmFieldMapping[] = [];
  const byLocalKey = new Map<string, CrmFieldMapping>();

  for (const row of rows) {
    byLocalKey.set(row.localKey, row);
    if (row.scope === 'buyer') buyer.push(row);
    else order.push(row);
  }

  _cache = { all: rows, buyer, order, byLocalKey };
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateCrmFieldMappingsCache(): void {
  _cache = null;
  _cacheAt = 0;
}
