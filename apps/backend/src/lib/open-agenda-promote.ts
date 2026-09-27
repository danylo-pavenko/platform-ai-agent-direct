/**
 * Promote soft booking agenda → hard bookingFunnel when CRM ids resolve uniquely.
 */

import { rankServices } from './service-search-rank.js';
import { loadSyncedServices } from './synced-services.js';
import { normalizeSlotTimeKey } from './booking-time-conflict.js';
import {
  factValue,
  markInferAttempted,
  type OpenAgenda,
} from './open-agenda.js';
import {
  funnelFromBookArgs,
  type BookingFunnel,
  type BookingFunnelMissing,
} from './booking-funnel.js';
import type { CrmServiceItem } from '../services/crm/types.js';
import { resolveCrmProvider } from './crm-routing.js';
import { getCrmAdapter } from '../services/crm/index.js';
import { getMastersCatalogPath } from './paths.js';
import { readFile } from 'node:fs/promises';

export function resolveUniqueServiceByName(
  query: string,
  catalog: CrmServiceItem[],
): CrmServiceItem | null {
  const q = query.trim();
  if (!q || catalog.length === 0) return null;

  const exact = catalog.filter(
    (s) => s.name.trim().toLowerCase() === q.toLowerCase(),
  );
  if (exact.length === 1) return exact[0]!;

  const ranked = rankServices(catalog, q, 5);
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0]!;

  // Unique only when top name clearly contains the query and others don't equally
  const qLower = q.toLowerCase();
  const strong = ranked.filter((s) => s.name.toLowerCase().includes(qLower));
  if (strong.length === 1) return strong[0]!;
  return null;
}

export function parseMastersLiveText(raw: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/\[master_id=([^\]]+)\]\s*(.+)/i);
    if (m) {
      out.push({ id: m[1]!.trim(), name: m[2]!.trim() });
      continue;
    }
    const m2 = t.match(/^(.+?)\s+\[master_id=([^\]]+)\]\s*$/i);
    if (m2) {
      out.push({ id: m2[2]!.trim(), name: m2[1]!.trim() });
    }
  }
  return out;
}

export function resolveUniqueMasterByName(
  name: string,
  masters: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const q = name.trim().toLowerCase();
  if (!q || masters.length === 0) return null;
  const exact = masters.filter((m) => m.name.trim().toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const starts = masters.filter(
    (m) =>
      m.name.trim().toLowerCase().startsWith(q) ||
      m.name.trim().toLowerCase().split(/\s+/)[0] === q,
  );
  if (starts.length === 1) return starts[0]!;
  return null;
}

async function loadMasterCatalog(): Promise<Array<{ id: string; name: string }>> {
  const fromFile: Array<{ id: string; name: string }> = [];
  try {
    const raw = await readFile(getMastersCatalogPath(), 'utf8');
    fromFile.push(...parseMastersLiveText(raw));
  } catch {
    // optional
  }
  if (fromFile.length > 0) return fromFile;

  try {
    const provider = await resolveCrmProvider('booking');
    const crm = getCrmAdapter(provider);
    if (crm.fetchEmployees) {
      const emps = await crm.fetchEmployees();
      return emps.map((e) => ({ id: e.id, name: e.name }));
    }
  } catch {
    // non-fatal
  }
  return [];
}

function normalizeUaDateLoose(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (!m) return undefined;
  const d = m[1]!.padStart(2, '0');
  const mo = m[2]!.padStart(2, '0');
  let y = m[3];
  if (!y) y = String(new Date().getFullYear());
  else if (y.length === 2) y = `20${y}`;
  return `${d}.${mo}.${y}`;
}

/**
 * If agenda is booking with enough facts and unique CRM service match → funnel.
 * Returns null when promote is not safe (keep soft agenda only).
 */
export async function promoteBookingFunnelFromAgenda(
  agenda: OpenAgenda,
  now = new Date(),
): Promise<BookingFunnel | null> {
  if (agenda.kind !== 'booking') return null;
  if (agenda.confidence === 'low') return null;
  if (agenda.status !== 'open') return null;

  const serviceName = factValue(agenda.knownFacts, 'послуга');
  if (!serviceName) return null;

  const synced = await loadSyncedServices();
  const catalog = synced.map(({ provider: _p, ...rest }) => rest);
  const service = resolveUniqueServiceByName(serviceName, catalog);
  if (!service) return null;

  const date =
    normalizeUaDateLoose(factValue(agenda.knownFacts, 'дата')) ??
    // weekday-only: cannot hard-book without a concrete date
    undefined;
  if (!date) return null;

  const timeRaw = factValue(agenda.knownFacts, 'час');
  const time = timeRaw ? normalizeSlotTimeKey(timeRaw) : undefined;
  const masterName = factValue(agenda.knownFacts, 'майстер');
  let masterId: string | undefined;
  let resolvedMasterName = masterName;
  if (masterName) {
    const masters = await loadMasterCatalog();
    const hit = resolveUniqueMasterByName(masterName, masters);
    if (hit) {
      masterId = hit.id;
      resolvedMasterName = hit.name;
    }
  }

  const missing: BookingFunnelMissing[] = [];
  if (agenda.awaiting.includes('name')) missing.push('name');
  if (agenda.awaiting.includes('phone')) missing.push('phone');
  if (missing.length === 0) {
    missing.push('name', 'phone');
  }

  if (time) {
    return funnelFromBookArgs({
      date,
      time,
      services: [
        {
          id: service.id,
          durationMin: service.durationMin,
          name: service.name,
          masterId,
        },
      ],
      masterId,
      masterName: resolvedMasterName,
      missing,
      now,
    });
  }

  // offering without time
  return {
    status: 'offering',
    date,
    masterId,
    masterName: resolvedMasterName,
    services: [
      {
        id: service.id,
        durationMin: service.durationMin,
        name: service.name,
        masterId,
      },
    ],
    missing,
    updatedAt: now.toISOString(),
  };
}

export function withPromoteSource(agenda: OpenAgenda, now = new Date()): OpenAgenda {
  return markInferAttempted(
    { ...agenda, source: 'promote', updatedAt: now.toISOString() },
    now,
  );
}
