/**
 * Canonical Appointment.services[] JSON lines + master id helpers.
 */

import { asCrmId } from './crm-ids.js';

const MASTER_ID_IN_NOTE_RE =
  /master_id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d+)/gi;

export type AppointmentServiceLine = {
  id: string;
  name?: string;
  price?: number;
  durationMin: number;
  masterId?: string;
};

export type ServiceMasterAssignment = {
  index?: number;
  serviceId?: string;
  masterId: string;
};

export function parseMasterIdsFromOrderNote(note: string | null | undefined): string[] {
  if (!note) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of note.matchAll(MASTER_ID_IN_NOTE_RE)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function parseFirstMasterIdFromOrderNote(note: string | null | undefined): string | null {
  return parseMasterIdsFromOrderNote(note)[0] ?? null;
}

export function normalizeAppointmentServices(raw: unknown): AppointmentServiceLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const o = row as Record<string, unknown>;
    const id = asCrmId(o.id);
    if (!id) return [];
    const durationMin =
      typeof o.durationMin === 'number'
        ? o.durationMin
        : typeof o.duration_min === 'number'
          ? o.duration_min
          : Number(o.durationMin) || Number(o.duration_min) || 60;
    const name = typeof o.name === 'string' ? o.name : undefined;
    const price = typeof o.price === 'number' ? o.price : undefined;
    const masterId = asCrmId(o.masterId) ?? asCrmId(o.master_id) ?? undefined;
    return [{ id, name, price, durationMin, masterId }];
  });
}

export function uniqueMasterIds(services: AppointmentServiceLine[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of services) {
    if (!row.masterId || seen.has(row.masterId)) continue;
    seen.add(row.masterId);
    out.push(row.masterId);
  }
  return out;
}

export function backfillServiceMasterIds(
  services: AppointmentServiceLine[],
  fallbackMasterId: string | null | undefined,
): { services: AppointmentServiceLine[]; changed: boolean } {
  const fallback = fallbackMasterId?.trim() || undefined;
  if (!fallback) return { services, changed: false };
  let changed = false;
  const next = services.map((row) => {
    if (row.masterId) return row;
    changed = true;
    return { ...row, masterId: fallback };
  });
  return { services: next, changed };
}

export function applyServiceMasterAssignments(
  services: AppointmentServiceLine[],
  assignments: ServiceMasterAssignment[],
): AppointmentServiceLine[] {
  const next = services.map((row) => ({ ...row }));
  for (const assignment of assignments) {
    const masterId = asCrmId(assignment.masterId);
    if (!masterId) continue;
    let idx =
      typeof assignment.index === 'number' && Number.isInteger(assignment.index)
        ? assignment.index
        : -1;
    if (idx < 0 && assignment.serviceId) {
      idx = next.findIndex((row) => row.id === assignment.serviceId && !row.masterId);
      if (idx < 0) idx = next.findIndex((row) => row.id === assignment.serviceId);
    }
    if (idx < 0 || idx >= next.length) {
      throw new Error('Unknown appointment service for master assignment');
    }
    const current = next[idx]!;
    next[idx] = { ...current, masterId };
  }
  return next;
}

export function servicesToJson(services: AppointmentServiceLine[]): AppointmentServiceLine[] {
  return services.map((row) => ({
    id: row.id,
    name: row.name,
    price: row.price,
    durationMin: row.durationMin,
    masterId: row.masterId,
  }));
}
