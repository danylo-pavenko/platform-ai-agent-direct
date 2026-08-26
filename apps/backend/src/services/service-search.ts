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
import { normalizeTenantTimezone } from '../lib/tenant-timezone.js';
import type { CrmServiceItem } from './crm/types.js';
import { intersectSlotLookupResults } from '../lib/slot-intersect.js';
import { normalizeSlotTimeKey, formatParallelServiceMasterLines } from '../lib/booking-time-conflict.js';
import { applyPersonalDurations } from './personal-duration.js';

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

export { formatParallelServiceMasterLines } from '../lib/booking-time-conflict.js';

const SLOT_TIMES_PER_DAY = 3;
/** Pull more from CRM/intersect before capping display (parallel races). */
const SLOT_TIMES_CANDIDATE_CAP = 12;

export async function getAvailableSlotsForContext(args: {
  date: string;
  branchCrmId: string;
  services: Array<{ id: string; durationMin: number; masterId?: string; name?: string }>;
  fullMonth?: boolean;
  masterId?: string;
  /** Clock time to omit (after TIME_CONFLICT). */
  excludeTime?: string;
  /** Local client id — personal duration from CRM history when available. */
  clientId?: string | null;
  /** Salon IANA timezone for CRM day bounds. */
  timeZone?: string | null;
}): Promise<string> {
  const provider = await resolveCrmProvider('booking');
  const crm = getCrmAdapter(provider);

  if (!crm.getAvailableSlots) {
    return 'Слоти недоступні — CRM не підтримує онлайн-запис.';
  }

  const personal = await applyPersonalDurations({
    clientId: args.clientId,
    services: args.services,
  });
  const servicesForLookup = personal.services;

  const assigned = servicesForLookup.map((s) => ({
    ...s,
    masterId: s.masterId || args.masterId,
  }));
  const uniqueMasters = [
    ...new Set(assigned.map((s) => s.masterId).filter((id): id is string => Boolean(id))),
  ];
  const parallelMasters = uniqueMasters.length > 1;
  const timeZone = normalizeTenantTimezone(args.timeZone);

  const runLookup = async (fullMonth: boolean | undefined) => {
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
            fullMonth,
            masterId,
            timeZone,
          }),
        ),
      );
      return intersectSlotLookupResults(lookups);
    }
    return crm.getAvailableSlots!({
      date: args.date,
      branchId: args.branchCrmId,
      services: assigned.map((s) => ({ id: s.id, durationMin: s.durationMin })),
      fullMonth,
      masterId: uniqueMasters[0] ?? args.masterId,
      timeZone,
    });
  };

  let result = await runLookup(args.fullMonth);
  let broadenedToMonth = false;
  const hasAnySlot = Object.values(result.slots).some((s) => s.length > 0);
  if (!hasAnySlot && args.fullMonth !== true) {
    result = await runLookup(true);
    broadenedToMonth = true;
  }

  const lines: string[] = [];
  if (personal.notes.length > 0) {
    lines.push(...personal.notes, '');
  }
  const masterMap = new Map(result.masters.map((m) => [m.id, m.name]));
  const excludeKey = args.excludeTime
    ? normalizeSlotTimeKey(args.excludeTime)
    : null;

  let daysShown = 0;
  for (const [day, slots] of Object.entries(result.slots)) {
    const filtered = (excludeKey
      ? slots.filter((s) => normalizeSlotTimeKey(s.time) !== excludeKey)
      : slots
    ).slice(0, SLOT_TIMES_CANDIDATE_CAP);
    const daySlots = filtered.slice(0, SLOT_TIMES_PER_DAY);
    if (daySlots.length === 0) continue;
    daysShown += 1;
    lines.push(`## ${day}`);
    for (const slot of daySlots) {
      if (parallelMasters && assigned.every((s) => s.masterId)) {
        const byService = assigned
          .map((s) => {
            const name = masterMap.get(s.masterId!) ?? s.masterId!;
            const svc = s.name?.trim() || s.id.slice(0, 8);
            return `${svc}: ${name}`;
          })
          .join('; ');
        const ids = formatSlotMastersLine(
          assigned.map((s) => s.masterId!).filter(Boolean),
          masterMap,
        );
        lines.push(`- ${slot.time} | ${byService} | tools: ${ids}`);
      } else {
        const mastersLabel = formatSlotMastersLine(slot.masterIds, masterMap);
        lines.push(`- ${slot.time} | майстри: ${mastersLabel || '—'}`);
      }
    }
    if (daysShown >= 5) break;
  }

  if (daysShown === 0) {
    const emptyMsg = parallelMasters
      ? 'Спільних вільних вікон для цих майстрів на обрану дату (і найближчі дні) не знайдено. Запропонуй інший день, інших майстрів або послідовний запис (один майстер). Не вигадуй «лист очікування» без процесу салону.'
      : uniqueMasters.length > 0
        ? 'Вільних слотів для цього майстра на обрану дату не знайдено. Запропонуй інший день або іншого майстра (без master_id).'
        : 'Вільних слотів на обрану дату не знайдено.';
    return personal.notes.length > 0
      ? `${personal.notes.join('\n')}\n\n${emptyMsg}`
      : emptyMsg;
  }

  if (broadenedToMonth) {
    lines.unshift(
      'На точну дату спільних вікон не було — нижче найближчі дні з вільними слотами.',
      '',
    );
  }

  if (parallelMasters) {
    const binding = formatParallelServiceMasterLines(assigned, masterMap);
    lines.push(
      '',
      'Паралельний запис (різні майстри, один start):',
      ...binding,
      'Swap майстрів між послугами або додавання ще однієї послуги → НОВИЙ get_available_slots з оновленими services[].master_id, потім book_appointment.',
      'Перед book_appointment після паузи клієнта — свіжий get_available_slots (слот міг зайнятись).',
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
