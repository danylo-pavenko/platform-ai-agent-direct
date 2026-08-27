/**
 * BeautyPro appointment service lines — fetch + delete (action=delete).
 */

import { asCrmId } from '../../lib/crm-ids.js';

export type BeautyproAppointmentServiceRow = {
  lineId: string;
  serviceId: string;
  serviceName?: string;
  start?: string;
  durationMin?: number;
  professionalId?: string;
};

export function parseBeautyproAppointmentServices(raw: unknown): BeautyproAppointmentServiceRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (!Array.isArray(raw)) return [];
  }
  const services = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { services?: unknown }).services)
      ? ((raw as { services: unknown[] }).services ?? [])
      : [];

  return services.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const o = row as Record<string, unknown>;
    const lineId = asCrmId(o.id);
    const serviceId = asCrmId(o.service);
    if (!lineId || !serviceId) return [];
    const serviceName =
      typeof o.serviceName === 'string'
        ? o.serviceName
        : typeof o.service_name === 'string'
          ? o.service_name
          : undefined;
    const start = typeof o.start === 'string' ? o.start : undefined;
    const durationMin =
      typeof o.duration === 'number' && o.duration > 0 ? o.duration : undefined;
    const professionalId = asCrmId(o.professional) ?? undefined;
    return [{ lineId, serviceId, serviceName, start, durationMin, professionalId }];
  });
}

export function matchBeautyproServiceLine(
  lines: BeautyproAppointmentServiceRow[],
  opts: { serviceCatalogId?: string | null; serviceName?: string | null },
): BeautyproAppointmentServiceRow | null {
  const id = opts.serviceCatalogId?.trim();
  if (id) {
    const byId = lines.filter((l) => l.serviceId === id);
    if (byId.length === 1) return byId[0]!;
    if (byId.length > 1) return byId[0]!;
  }
  const name = opts.serviceName?.trim().toLowerCase();
  if (!name) return null;
  const byName = lines.filter((l) => (l.serviceName ?? '').toLowerCase().includes(name));
  if (byName.length === 1) return byName[0]!;
  return null;
}

export function buildBeautyproServiceDeleteBody(lineId: string): Record<string, unknown> {
  return {
    services: [{ id: lineId, action: 'delete' }],
  };
}
