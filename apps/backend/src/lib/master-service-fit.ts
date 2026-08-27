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

/**
 * When several professionals share a first/display name, append positions
 * (or a short id) so the model does not bind the wrong UUID by name alone.
 */
export function disambiguateMasterDisplayName(
  id: string,
  name: string,
  peers: Array<{ id: string; name: string; positionNames?: string[] }>,
): string {
  const key = normalizeMasterNameKey(name);
  if (!key) return name || id;
  const same = peers.filter((p) => normalizeMasterNameKey(p.name) === key);
  if (same.length <= 1) return name.trim() || id;
  const me = peers.find((p) => p.id === id);
  const pos = (me?.positionNames ?? []).map((p) => p.trim()).filter(Boolean);
  if (pos.length > 0) return `${name.trim()} (${pos.join(', ')})`;
  return `${name.trim()} [#${id.slice(0, 8)}]`;
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
