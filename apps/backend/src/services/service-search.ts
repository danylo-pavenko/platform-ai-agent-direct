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
} from '../lib/service-search-rank.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmServiceItem } from './crm/types.js';

export { formatServiceLine, formatServicePrice } from '../lib/service-search-rank.js';

export type ServiceSearchResult = {
  contextBlock: string;
  matchCount: number;
  usedQuery: string;
  broadenedFrom?: string;
};

function toContext(items: CrmServiceItem[]): string {
  return items.map(formatServiceLine).join('\n');
}

function rankList(
  items: CrmServiceItem[],
  query: string,
  limit: number,
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
  return {
    contextBlock: toContext(ranked.items),
    matchCount: ranked.items.length,
    usedQuery: ranked.usedQuery,
    broadenedFrom: ranked.broadenedFrom,
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
 */
export async function searchServicesForContext(
  query: string,
  limit: number = DEFAULT_SERVICE_SEARCH_LIMIT,
): Promise<ServiceSearchResult> {
  const cap = clampServiceSearchLimit(limit);
  const q = query.trim();
  if (!q) {
    return { contextBlock: '', matchCount: 0, usedQuery: '' };
  }

  const snapshot = await loadSnapshotForProvider();
  if (snapshot.length > 0) {
    const fromSnap = rankList(snapshot, q, cap);
    if (fromSnap.matchCount > 0) {
      return fromSnap;
    }
  }

  const live = await loadLiveServices(q);
  if (live.length === 0) {
    return { contextBlock: '', matchCount: 0, usedQuery: q };
  }

  return rankList(live, q, cap);
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
  services: Array<{ id: string; durationMin: number }>;
  fullMonth?: boolean;
  masterId?: string;
}): Promise<string> {
  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);

  if (!crm.getAvailableSlots) {
    return 'Слоти недоступні — CRM не підтримує онлайн-запис.';
  }

  const result = await crm.getAvailableSlots({
    date: args.date,
    branchId: args.branchCrmId,
    services: args.services,
    fullMonth: args.fullMonth,
    masterId: args.masterId,
  });

  const lines: string[] = [];
  const masterMap = new Map(result.masters.map((m) => [m.id, m.name]));

  for (const [day, slots] of Object.entries(result.slots)) {
    const daySlots = slots.slice(0, 12);
    if (daySlots.length === 0) continue;
    lines.push(`## ${day}`);
    for (const slot of daySlots) {
      const mastersLabel = formatSlotMastersLine(slot.masterIds, masterMap);
      lines.push(`- ${slot.time} | майстри: ${mastersLabel || '—'}`);
    }
  }

  if (lines.length === 0) {
    return args.masterId
      ? 'Вільних слотів для цього майстра на обрану дату не знайдено. Запропонуй інший день або іншого майстра (без master_id).'
      : 'Вільних слотів на обрану дату не знайдено.';
  }

  lines.push(
    '',
    'Для book_appointment використовуй master_id з цього списку. Клієнту показуй лише імʼя майстра, не id.',
  );
  return lines.join('\n');
}
