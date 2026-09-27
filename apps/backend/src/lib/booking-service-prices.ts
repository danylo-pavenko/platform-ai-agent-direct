/**
 * Fill booking line prices: agent quote → synced services.json → live CRM.
 * (Salon services snapshot is the CRM catalog on disk — not Shop-Express file.)
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import { REPO_ROOT } from './paths.js';
import { loadSyncedServices, type SyncedServiceRow } from './synced-services.js';
import { catalogLinePrice } from './service-price-resolve.js';
import type { CrmServiceItem } from '../services/crm/types.js';
import { resolveCrmProvider } from './crm-routing.js';
import { getCrmAdapter } from '../services/crm/index.js';
import type { AppointmentServiceLine } from './appointment-services.js';
import type { OrderLineItem } from './order-normalize.js';

const log = pino({ name: 'booking-service-prices' });

type MasterRow = { id: string; name: string; positionIds?: string[] };

function mastersSnapshotPath(): string {
  return resolve(REPO_ROOT, 'data', 'masters.json');
}

async function loadMastersSnapshot(): Promise<MasterRow[]> {
  try {
    const raw = await readFile(mastersSnapshotPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const o = row as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!id || !name) return [];
      const positionIds = Array.isArray(o.positionIds)
        ? o.positionIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : undefined;
      return [{ id, name, positionIds }];
    });
  } catch {
    return [];
  }
}

let liveServicesCache: { at: number; rows: CrmServiceItem[] } | null = null;
const LIVE_TTL_MS = 60_000;

async function loadLiveServicesFallback(): Promise<CrmServiceItem[]> {
  const now = Date.now();
  if (liveServicesCache && now - liveServicesCache.at < LIVE_TTL_MS) {
    return liveServicesCache.rows;
  }
  try {
    const provider = await resolveCrmProvider('services');
    const crm = getCrmAdapter(provider);
    if (!crm.fetchServices) return [];
    const rows = await crm.fetchServices();
    liveServicesCache = { at: now, rows };
    return rows;
  } catch (err) {
    log.warn({ err }, 'Live CRM services fetch for price fill failed');
    return [];
  }
}

function findService(
  id: string,
  synced: SyncedServiceRow[],
  live: CrmServiceItem[],
): CrmServiceItem | undefined {
  const fromSync = synced.find((s) => s.id === id);
  if (fromSync) {
    const price = catalogLinePrice(fromSync);
    if (price != null && price > 0) return fromSync;
    // Snapshot present but all zeros — still try live below for fresher priceRows.
  }
  const fromLive = live.find((s) => s.id === id);
  if (fromLive) return fromLive;
  return fromSync;
}

export async function resolveBookingUnitPrice(params: {
  serviceId: string;
  masterId?: string;
  agentPrice?: number;
  synced?: SyncedServiceRow[];
  masters?: MasterRow[];
  live?: CrmServiceItem[];
}): Promise<number> {
  if (typeof params.agentPrice === 'number' && params.agentPrice > 0) {
    return params.agentPrice;
  }

  const synced = params.synced ?? (await loadSyncedServices());
  const masters = params.masters ?? (await loadMastersSnapshot());
  let live = params.live;
  const master = params.masterId
    ? masters.find((m) => m.id === params.masterId)
    : undefined;
  const positionIds = master?.positionIds;

  let svc = findService(params.serviceId, synced, live ?? []);
  let price = catalogLinePrice(svc, { masterPositionIds: positionIds });
  if (price != null && price > 0) return price;

  // Snapshot miss or zero → one live CRM pull
  if (live == null) {
    live = await loadLiveServicesFallback();
    svc = findService(params.serviceId, synced, live);
    price = catalogLinePrice(svc, { masterPositionIds: positionIds });
    if (price != null && price > 0) return price;
  }

  return 0;
}

/** Enrich appointment service lines in place (agent price wins). */
export async function enrichAppointmentServicePrices(
  services: AppointmentServiceLine[],
): Promise<AppointmentServiceLine[]> {
  if (services.length === 0) return services;
  const synced = await loadSyncedServices();
  const masters = await loadMastersSnapshot();
  let live: CrmServiceItem[] | undefined;

  const out: AppointmentServiceLine[] = [];
  for (const s of services) {
    const agentPrice = typeof s.price === 'number' && s.price > 0 ? s.price : 0;
    if (agentPrice > 0) {
      out.push(s);
      continue;
    }
    // Lazy live load only if synced cannot price this id
    const syncedHit = synced.find((r) => r.id === s.id);
    const syncedPrice = catalogLinePrice(syncedHit ?? null, {
      masterPositionIds: s.masterId
        ? masters.find((m) => m.id === s.masterId)?.positionIds
        : undefined,
    });
    if (syncedPrice == null || !(syncedPrice > 0)) {
      live = live ?? (await loadLiveServicesFallback());
    }
    const price = await resolveBookingUnitPrice({
      serviceId: s.id,
      masterId: s.masterId,
      agentPrice: 0,
      synced,
      masters,
      live: live ?? [],
    });
    out.push(price > 0 ? { ...s, price } : s);
  }
  return out;
}

/**
 * Map order line items by name → service id via appointment lines, then fill 0 prices.
 */
export async function enrichBookingOrderItems(
  items: OrderLineItem[],
  appointmentServices?: AppointmentServiceLine[] | null,
): Promise<{ items: OrderLineItem[]; changed: boolean }> {
  if (items.length === 0) return { items, changed: false };

  const enrichedAppt = appointmentServices?.length
    ? await enrichAppointmentServicePrices(appointmentServices)
    : [];

  const byName = new Map<string, number>();
  for (const s of enrichedAppt) {
    const key = (s.name ?? '').trim().toLowerCase();
    if (!key) continue;
    if (typeof s.price === 'number' && s.price > 0) byName.set(key, s.price);
  }

  // Also resolve by appointment service id order when names match 1:1
  let live: CrmServiceItem[] | undefined;
  const synced = await loadSyncedServices();
  const masters = await loadMastersSnapshot();

  let changed = false;
  const next: OrderLineItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const line = items[i]!;
    const qty = line.qty > 0 ? line.qty : 1;
    if (line.price > 0) {
      next.push(line);
      continue;
    }
    const nameKey = line.name.trim().toLowerCase();
    let price = byName.get(nameKey) ?? 0;
    if (!(price > 0) && enrichedAppt[i]?.id) {
      const appt = enrichedAppt[i]!;
      if (typeof appt.price === 'number' && appt.price > 0) {
        price = appt.price;
      } else {
        live = live ?? (await loadLiveServicesFallback());
        price = await resolveBookingUnitPrice({
          serviceId: appt.id,
          masterId: appt.masterId,
          synced,
          masters,
          live,
        });
      }
    }
    if (!(price > 0) && nameKey) {
      // Name-only match against synced catalog
      const hit = synced.find((s) => s.name.trim().toLowerCase() === nameKey);
      if (hit) {
        price = catalogLinePrice(hit) ?? 0;
      }
    }
    if (price > 0) {
      changed = true;
      next.push({ ...line, price, qty });
    } else {
      next.push(line);
    }
  }
  return { items: next, changed };
}
