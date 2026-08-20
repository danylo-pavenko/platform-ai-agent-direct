/**
 * Live + synced service search for booking-mode agents (CleverBOX, BeautyPro, …).
 */

import { resolveCrmProvider } from '../lib/crm-routing.js';
import { loadSyncedServices } from '../lib/synced-services.js';
import {
  clampServiceSearchLimit,
  DEFAULT_SERVICE_SEARCH_LIMIT,
  expandServiceQueries,
  formatServiceLine,
  rankAcrossQueries,
  rankServices,
} from '../lib/service-search-rank.js';
import {
  extractGenderedServiceIntent,
  formatClientIntentNote,
  preferIntentFirst,
  queryDropsClientGender,
} from '../lib/service-search-intent.js';
import {
  formatResolvedPrice,
  resolveServicePrice,
} from '../lib/service-price-resolve.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmServiceItem } from './crm/types.js';
import { intersectSlotLookupResults } from '../lib/slot-intersect.js';

export { formatServiceLine, formatServicePrice } from '../lib/service-search-rank.js';

export type ServiceSearchResult = {
  contextBlock: string;
  matchCount: number;
  usedQuery: string;
  broadenedFrom?: string;
  /** Client gendered intent was used to re-order hits. */
  clientIntentQuery?: string;
  intentNote?: string;
};

function toContext(items: CrmServiceItem[]): string {
  return items.map(formatServiceLine).join('\n');
}

function rankList(
  items: CrmServiceItem[],
  query: string,
  limit: number,
  clientMessage?: string,
): ServiceSearchResult {
  const variants = expandServiceQueries(query);
  if (variants.length === 0 || items.length === 0) {
    return {
      contextBlock: '',
      matchCount: 0,
      usedQuery: query.trim(),
    };
  }

  const ranked = rankAcrossQueries(items, variants, limit);
  let itemsOut = ranked.items;
  let clientIntentQuery: string | undefined;
  let intentNote: string | undefined;

  const intent = clientMessage ? extractGenderedServiceIntent(clientMessage) : null;
  if (intent && (queryDropsClientGender(query, clientMessage!) || intent !== ranked.usedQuery)) {
    const intentHits = rankServices(items, intent, limit);
    if (intentHits.length > 0) {
      itemsOut = preferIntentFirst(ranked.items, intentHits, limit);
      clientIntentQuery = intent;
      if (queryDropsClientGender(query, clientMessage!)) {
        intentNote = formatClientIntentNote(intent);
      }
    }
  }

  return {
    contextBlock: toContext(itemsOut),
    matchCount: itemsOut.length,
    usedQuery: ranked.usedQuery,
    broadenedFrom: ranked.broadenedFrom,
    clientIntentQuery,
    intentNote,
  };
}

async function loadSnapshotForProvider(): Promise<CrmServiceItem[]> {
  const provider = await resolveCrmProvider('services');
  const synced = await loadSyncedServices();
  if (synced.length === 0) return [];
  const forProvider = synced.filter((s) => s.provider === provider);
  return forProvider.length > 0 ? forProvider : synced;
}

async function loadLiveServices(query: string): Promise<CrmServiceItem[]> {
  const provider = await resolveCrmProvider('services');
  const crm = getCrmAdapter(provider);

  if (crm.fetchServices) {
    return crm.fetchServices();
  }
  if (crm.searchServices) {
    // Adapters without fetchServices: ask for a wide slice, then re-rank locally.
    return crm.searchServices(query, 50);
  }
  return [];
}

/**
 * Search salon services: prefer synced snapshot (fast), then live CRM if no hits.
 * One list load + in-memory ranking across query variants (no N HTTP broaden loops).
 * Optional clientMessage re-ranks when the model drops gendered intent (e.g. «чоловічий»).
 */
export async function searchServicesForContext(
  query: string,
  limit: number = DEFAULT_SERVICE_SEARCH_LIMIT,
  opts?: { clientMessage?: string },
): Promise<ServiceSearchResult> {
  const cap = clampServiceSearchLimit(limit);
  const q = query.trim();
  if (!q) {
    return { contextBlock: '', matchCount: 0, usedQuery: '' };
  }

  const clientMessage = opts?.clientMessage;

  const snapshot = await loadSnapshotForProvider();
  if (snapshot.length > 0) {
    const fromSnap = rankList(snapshot, q, cap, clientMessage);
    if (fromSnap.matchCount > 0) {
      return fromSnap;
    }
  }

  const live = await loadLiveServices(q);
  if (live.length === 0) {
    return { contextBlock: '', matchCount: 0, usedQuery: q };
  }

  return rankList(live, q, cap, clientMessage);
}

/** Format slot masters for the agent (ids for tools; names for client copy). */
export function formatSlotMastersLine(
  masterIds: string[],
  masterMap: Map<string, string>,
  limit = 4,
): string {
  return masterIds
    .slice(0, limit)
    .map((id) => {
      const name = masterMap.get(id) ?? id;
      return `[master_id=${id}] ${name}`;
    })
    .join(', ');
}

export async function getAvailableSlotsForContext(args: {
  date: string;
  branchCrmId: string;
  services: Array<{ id: string; durationMin: number; masterId?: string }>;
  fullMonth?: boolean;
  masterId?: string;
}): Promise<string> {
  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);

  if (!crm.getAvailableSlots) {
    return 'Слоти недоступні — CRM не підтримує онлайн-запис.';
  }

  const assigned = args.services.map((s) => ({
    ...s,
    masterId: s.masterId || args.masterId,
  }));
  const uniqueMasters = [
    ...new Set(assigned.map((s) => s.masterId).filter((id): id is string => Boolean(id))),
  ];
  const parallelMasters = uniqueMasters.length > 1;

  let result: {
    slots: Record<string, Array<{ date: string; time: string; masterIds: string[] }>>;
    masters: Array<{ id: string; name: string }>;
  };

  if (parallelMasters) {
    const grouped = new Map<string, typeof assigned>();
    for (const row of assigned) {
      const key = row.masterId!;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    const lookups = await Promise.all(
      [...grouped.entries()].map(([masterId, services]) =>
        crm.getAvailableSlots!({
          date: args.date,
          branchId: args.branchCrmId,
          services: services.map((s) => ({ id: s.id, durationMin: s.durationMin })),
          fullMonth: args.fullMonth,
          masterId,
        }),
      ),
    );
    result = intersectSlotLookupResults(lookups);
  } else {
    result = await crm.getAvailableSlots({
      date: args.date,
      branchId: args.branchCrmId,
      services: assigned.map((s) => ({ id: s.id, durationMin: s.durationMin })),
      fullMonth: args.fullMonth,
      masterId: uniqueMasters[0] ?? args.masterId,
    });
  }

  const lines: string[] = [];
  const masterMap = new Map(result.masters.map((m) => [m.id, m.name]));

  for (const [day, slots] of Object.entries(result.slots)) {
    const daySlots = slots.slice(0, 3);
    if (daySlots.length === 0) continue;
    lines.push(`## ${day}`);
    for (const slot of daySlots) {
      const mastersLabel = formatSlotMastersLine(slot.masterIds, masterMap);
      lines.push(`- ${slot.time} | майстри: ${mastersLabel || '—'}`);
    }
  }

  if (lines.length === 0) {
    return uniqueMasters.length > 0
      ? 'Вільних слотів для цього майстра на обрану дату не знайдено. Запропонуй інший день або іншого майстра (без master_id).'
      : 'Вільних слотів на обрану дату не знайдено.';
  }

  if (parallelMasters) {
    lines.push(
      '',
      'Паралельний запис: різні майстри на той самий час. У book_appointment передай services[].master_id на кожен рядок.',
    );
  }

  const priceMasterId = uniqueMasters.length === 1 ? uniqueMasters[0] : undefined;
  if (priceMasterId && args.services.length > 0) {
    try {
      const priceLines = await formatMasterServicePrices({
        masterId: priceMasterId,
        branchId: args.branchCrmId,
        serviceIds: args.services.map((s) => s.id),
      });
      if (priceLines.length > 0) {
        lines.push('', 'Ціни для обраного майстра:', ...priceLines);
      }
    } catch {
      // Non-fatal — slots still useful without grade quote.
    }
  }

  lines.push(
    '',
    parallelMasters
      ? 'Для book_appointment використовуй services[].master_id з цього списку. Клієнту показуй лише імʼя майстра, не id.'
      : 'Для book_appointment використовуй master_id з цього списку. Клієнту показуй лише імʼя майстра, не id.',
  );
  return lines.join('\n');
}

async function formatMasterServicePrices(params: {
  masterId: string;
  branchId: string;
  serviceIds: string[];
}): Promise<string[]> {
  const provider = await resolveCrmProvider('services');
  const crm = getCrmAdapter(provider);

  let masterPositionIds: string[] = [];
  if (crm.fetchEmployees) {
    const employees = await crm.fetchEmployees();
    const master = employees.find((e) => e.id === params.masterId);
    masterPositionIds = master?.positionIds ?? [];
  }

  const synced = await loadSyncedServices();
  const byProvider = synced.filter((s) => s.provider === provider);
  const catalog = byProvider.length > 0 ? byProvider : synced;

  let live: CrmServiceItem[] = [];
  if (catalog.length === 0 && crm.fetchServices) {
    live = await crm.fetchServices();
  }
  const list = catalog.length > 0 ? catalog : live;

  const lines: string[] = [];
  for (const sid of params.serviceIds) {
    const svc = list.find((s) => s.id === sid);
    if (!svc) continue;
    const resolved = resolveServicePrice(svc, {
      branchId: params.branchId,
      masterPositionIds,
    });
    const label = formatResolvedPrice(resolved);
    const grade =
      resolved.kind === 'fixed' && resolved.positionName
        ? ` (${resolved.positionName})`
        : '';
    lines.push(`- ${svc.name}: ${label}${grade}`);
  }
  return lines;
}
