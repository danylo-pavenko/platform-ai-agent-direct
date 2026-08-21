/**
 * Personal booking duration from CRM visit history (BeautyPro).
 * Prefers wall-clock (start → sale_date) when available; else booked duration.
 */

import type { CrmVisitHistoryItem } from '../services/crm/types.js';
import { tokenizeServiceQuery } from './service-search-rank.js';

export type DurationSource = 'history_actual' | 'history_booked' | 'catalog';

export type RecommendedDuration = {
  durationMin: number;
  source: DurationSource;
  sampleCount: number;
  catalogDurationMin: number;
  note: string;
};

const MIN_SAMPLE_MIN = 15;
const MAX_SAMPLE_MIN = 240;
const MAX_SAMPLES = 5;

/** Compute wall-clock minutes from visit start to sale close; null if invalid. */
export function computeActualDurationMin(
  startIso: string,
  saleDateIso: string,
): number | null {
  const startMs = Date.parse(startIso);
  const saleMs = Date.parse(saleDateIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(saleMs)) return null;
  const deltaMin = Math.round((saleMs - startMs) / 60_000);
  if (deltaMin < MIN_SAMPLE_MIN || deltaMin > MAX_SAMPLE_MIN) return null;
  return deltaMin;
}

/** Effective minutes for matching: actual if present, else booked. */
export function effectiveVisitDurationMin(visit: CrmVisitHistoryItem): number {
  if (
    typeof visit.actualDurationMin === 'number' &&
    visit.actualDurationMin >= MIN_SAMPLE_MIN
  ) {
    return visit.actualDurationMin;
  }
  if (typeof visit.bookedDurationMin === 'number' && visit.bookedDurationMin > 0) {
    return visit.bookedDurationMin;
  }
  return visit.durationMin > 0 ? visit.durationMin : 0;
}

function roundToStep(min: number, step: number): number {
  return Math.round(min / step) * step;
}

function clampDuration(catalog: number, candidate: number): number {
  const lo = Math.max(MIN_SAMPLE_MIN, roundToStep(catalog * 0.5, 5));
  const hi = Math.min(MAX_SAMPLE_MIN, Math.max(catalog * 2, catalog));
  const clamped = Math.min(hi, Math.max(lo, candidate));
  // Keep 5-min fidelity (e.g. actual 71 → 70), not coarse 15-min jumps.
  return Math.max(MIN_SAMPLE_MIN, roundToStep(clamped, 5));
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function visitServiceNames(visit: CrmVisitHistoryItem): string[] {
  return visit.items
    .filter((i) => /service/i.test(i.type) || i.type === 'Service' || !i.type)
    .map((i) => i.name)
    .filter(Boolean);
}

function nameOverlapScore(serviceName: string, candidateName: string): number {
  const tokens = tokenizeServiceQuery(serviceName);
  if (tokens.length === 0) return 0;
  const hay = candidateName.toLowerCase();
  let matched = 0;
  for (const t of tokens) {
    if (hay.includes(t)) matched++;
  }
  return matched / tokens.length;
}

function visitMatchesService(
  visit: CrmVisitHistoryItem,
  opts: { serviceId?: string; serviceName?: string },
): boolean {
  const serviceId = opts.serviceId?.trim();
  if (serviceId) {
    if (visit.items.some((i) => i.id === serviceId)) return true;
  }
  const serviceName = opts.serviceName?.trim();
  if (!serviceName) return Boolean(serviceId && visit.items.some((i) => i.id === serviceId));

  const names = visitServiceNames(visit);
  if (names.length === 0) {
    // Fall back to any item name
    for (const it of visit.items) {
      if (nameOverlapScore(serviceName, it.name) >= 0.5) return true;
    }
    return false;
  }
  return names.some((n) => nameOverlapScore(serviceName, n) >= 0.5);
}

type RankedSample = {
  durationMin: number;
  dateMs: number;
  sameMaster: boolean;
  paid: boolean;
  hasActual: boolean;
};

function rankSamples(a: RankedSample, b: RankedSample): number {
  if (a.sameMaster !== b.sameMaster) return a.sameMaster ? -1 : 1;
  if (a.paid !== b.paid) return a.paid ? -1 : 1;
  if (a.hasActual !== b.hasActual) return a.hasActual ? -1 : 1;
  return b.dateMs - a.dateMs;
}

/**
 * Resolve personal duration for slots/book from CRM history.
 * Falls back to catalog when no matching visits.
 */
export function resolveRecommendedDuration(opts: {
  catalogDurationMin: number;
  serviceId?: string;
  serviceName?: string;
  masterId?: string;
  visits: CrmVisitHistoryItem[];
}): RecommendedDuration {
  const catalog =
    Number.isFinite(opts.catalogDurationMin) && opts.catalogDurationMin > 0
      ? Math.round(opts.catalogDurationMin)
      : 60;

  const masterId = opts.masterId?.trim();
  const samples: RankedSample[] = [];

  for (const visit of opts.visits) {
    const effective = effectiveVisitDurationMin(visit);
    if (effective < MIN_SAMPLE_MIN) continue;
    if (!visitMatchesService(visit, opts)) continue;

    const dateMs = Date.parse(visit.date);
    samples.push({
      durationMin: effective,
      dateMs: Number.isFinite(dateMs) ? dateMs : 0,
      sameMaster: Boolean(masterId && visit.professionalId === masterId),
      paid: visit.paid === true,
      hasActual:
        typeof visit.actualDurationMin === 'number' &&
        visit.actualDurationMin >= MIN_SAMPLE_MIN,
    });
  }

  if (samples.length === 0) {
    return {
      durationMin: catalog,
      source: 'catalog',
      sampleCount: 0,
      catalogDurationMin: catalog,
      note: `каталог ${catalog} хв (немає схожих візитів в історії)`,
    };
  }

  samples.sort(rankSamples);
  const picked = samples.slice(0, MAX_SAMPLES);
  const med = median(picked.map((s) => s.durationMin));
  const durationMin = clampDuration(catalog, med);
  const usedActual = picked.some((s) => s.hasActual);
  const source: DurationSource = usedActual ? 'history_actual' : 'history_booked';

  return {
    durationMin,
    source,
    sampleCount: picked.length,
    catalogDurationMin: catalog,
    note:
      source === 'history_actual'
        ? `історія actual, n=${picked.length}; каталог ${catalog} хв`
        : `історія booked, n=${picked.length}; каталог ${catalog} хв`,
  };
}

/** One-line label for tool results. */
export function formatRecommendedDurationLine(rec: RecommendedDuration): string {
  if (rec.source === 'catalog') {
    return `Тривалість для слотів: ${rec.durationMin} хв (${rec.note}).`;
  }
  return `Тривалість для слотів: ${rec.durationMin} хв (${rec.note}).`;
}

/** Block for get_client_crm_history when a service is specified. */
export function formatRecommendedDurationBlock(rec: RecommendedDuration): string {
  if (rec.source === 'catalog') {
    return `РЕКОМЕНДОВАНА_ТРИВАЛІСТЬ: ${rec.durationMin} хв (${rec.note}). Для get_available_slots / book_appointment платформа підставить це сама, якщо є історія.`;
  }
  return (
    `РЕКОМЕНДОВАНА_ТРИВАЛІСТЬ: ${rec.durationMin} хв (${rec.note}). ` +
    `Озвуч клієнту орієнтир («зазвичай у тебе ~${rec.durationMin} хв»). ` +
    `Для слотів/запису довіряй цій тривалості — платформа підставить її в free_time / book.`
  );
}
