/**
 * Master ↔ service fit (BeautyPro grades) and same-name disambiguation labels.
 * Pure helpers + catalog/employee I/O for book_appointment soft-guard.
 */

import { resolveServicePrice } from './service-price-resolve.js';
import { loadSyncedServices } from './synced-services.js';
import { resolveCrmProvider } from './crm-routing.js';
import { getCrmAdapter } from '../services/crm/index.js';
import type { CrmEmployee, CrmServiceItem } from '../services/crm/types.js';

export type MasterServiceMismatch = {
  serviceId: string;
  serviceName: string;
  masterId: string;
  masterName: string;
  reason: string;
};

export function normalizeMasterNameKey(name: string): string {
  return name.trim().toLocaleLowerCase('uk');
}

/** First token only — «Анастасія Грева» and «Анастасія» share a key. */
export function masterFirstNameKey(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.toLocaleLowerCase('uk');
}

/** Client-facing given name without surname. */
export function masterGivenName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return (first && first.trim()) || name.trim();
}

/**
 * When several professionals share a first/display name, append positions
 * (or a short id) so the model does not bind the wrong UUID by name alone.
 * Labels for the agent/slots use given name only (no surname) — surname stays in CRM.
 */
export function disambiguateMasterDisplayName(
  id: string,
  name: string,
  peers: Array<{ id: string; name: string; positionNames?: string[] }>,
): string {
  const given = masterGivenName(name);
  if (!given) return id;
  const key = masterFirstNameKey(name);
  const same = peers.filter((p) => masterFirstNameKey(p.name) === key);
  if (same.length <= 1) return given;
  const me = peers.find((p) => p.id === id);
  const pos = (me?.positionNames ?? []).map((p) => p.trim()).filter(Boolean);
  if (pos.length > 0) return `${given} (${pos.join(', ')})`;
  return `${given} [master_id=${id}]`;
}

/** Build id → disambiguated label map for slot / history formatting. */
export function buildDisambiguatedMasterMap(
  masters: Array<{ id: string; name: string; positionNames?: string[] }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of masters) {
    map.set(m.id, disambiguateMasterDisplayName(m.id, m.name, masters));
  }
  return map;
}

/**
 * Drop masters whose BeautyPro grades have no price row for every listed service.
 * Incomplete CRM data → keep the master (never false-positive filter).
 */
export function filterMasterIdsForServices(
  masterIds: string[],
  serviceIds: string[],
  employees: CrmEmployee[],
  catalog: CrmServiceItem[],
  branchId?: string | null,
): string[] {
  if (masterIds.length === 0 || serviceIds.length === 0) return masterIds;
  const byId = new Map(employees.map((e) => [e.id, e]));

  return masterIds.filter((mid) => {
    const employee = byId.get(mid);
    const positionIds = employee?.positionIds ?? [];
    if (positionIds.length === 0) return true;

    for (const sid of serviceIds) {
      const svc = catalog.find((s) => s.id === sid);
      if (!svc?.priceRows || svc.priceRows.length === 0) continue;
      const resolved = resolveServicePrice(svc, {
        branchId,
        masterPositionIds: positionIds,
      });
      if (resolved.kind === 'unavailable') return false;
    }
    return true;
  });
}

export function findUnavailableMasterAssignments(opts: {
  services: Array<{ id: string; name?: string; masterId?: string }>;
  employees: CrmEmployee[];
  catalog: CrmServiceItem[];
  branchId?: string | null;
}): MasterServiceMismatch[] {
  const byId = new Map(opts.employees.map((e) => [e.id, e]));
  const out: MasterServiceMismatch[] = [];

  for (const row of opts.services) {
    const masterId = row.masterId?.trim();
    if (!masterId) continue;
    const employee = byId.get(masterId);
    const positionIds = employee?.positionIds ?? [];
    // Without grade ids we cannot prove mismatch — skip (CleverBOX / incomplete sync).
    if (positionIds.length === 0) continue;

    const svc = opts.catalog.find((s) => s.id === row.id);
    if (!svc) continue;
    // No price matrix → cannot prove specialty mismatch.
    if (!svc.priceRows || svc.priceRows.length === 0) continue;

    const resolved = resolveServicePrice(svc, {
      branchId: opts.branchId,
      masterPositionIds: positionIds,
    });
    if (resolved.kind !== 'unavailable') continue;

    out.push({
      serviceId: row.id,
      serviceName: row.name?.trim() || svc.name,
      masterId,
      masterName: disambiguateMasterDisplayName(
        masterId,
        employee?.name ?? masterId,
        opts.employees,
      ),
      reason: resolved.reason,
    });
  }

  return out;
}

export function formatMasterServiceMismatchToolResult(
  mismatches: MasterServiceMismatch[],
): string {
  const lines = mismatches.map(
    (m) =>
      `- ${m.serviceName} [service_id=${m.serviceId}] × ${m.masterName} [master_id=${m.masterId}]: ${m.reason}`,
  );
  return [
    '[book_appointment] failed MASTER_SERVICE_MISMATCH — майстер не підходить до послуги (рівень/спеціалізація в CRM).',
    'НЕ кажи клієнту що записано. Зроби get_available_slots БЕЗ цього master_id (або з іншим майстром зі слотів саме для цієї послуги), потім book знову.',
    'При двох майстрах з однаковим імʼям завжди бери UUID з останнього get_available_slots, не з історії іншої категорії.',
    ...lines,
  ].join('\n');
}

/**
 * Live check used by book_appointment before creating a local visit.
 * Returns [] when CRM data is insufficient to judge (never false-positive).
 */
export async function checkBookingMasterServiceFit(opts: {
  services: Array<{ id: string; name?: string; masterId?: string }>;
  branchId?: string | null;
}): Promise<MasterServiceMismatch[]> {
  const hasMaster = opts.services.some((s) => Boolean(s.masterId?.trim()));
  if (!hasMaster) return [];

  try {
    const provider = await resolveCrmProvider('booking');
    const crm = getCrmAdapter(provider);
    if (!crm.fetchEmployees) return [];

    const [employees, synced] = await Promise.all([
      crm.fetchEmployees(),
      loadSyncedServices(),
    ]);

    let catalog: CrmServiceItem[] = synced.filter((s) => s.provider === provider);
    if (catalog.length === 0 && crm.fetchServices) {
      catalog = await crm.fetchServices();
    }
    if (catalog.length === 0) {
      catalog = synced;
    }

    return findUnavailableMasterAssignments({
      services: opts.services,
      employees,
      catalog,
      branchId: opts.branchId,
    });
  } catch {
    return [];
  }
}
