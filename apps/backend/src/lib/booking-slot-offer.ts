import { normalizeSlotTimeKey } from './booking-time-conflict.js';

/** Keep the last slot offer for slow IG contact collection after times were shown. */
export const BOOKING_SLOT_OFFER_TTL_MS = 2 * 60 * 60 * 1000;

export type BookingSlotOfferDay = {
  date: string;
  times: string[];
};

export type BookingSlotOfferService = {
  id: string;
  durationMin: number;
  masterId?: string;
  name?: string;
};

export type BookingSlotOffer = {
  date: string;
  days: BookingSlotOfferDay[];
  services: BookingSlotOfferService[];
  masterId?: string;
  masterIds: string[];
  fetchedAt: string;
};

export function isFreshBookingSlotOffer(
  offer: BookingSlotOffer | null | undefined,
  now = new Date(),
  ttlMs = BOOKING_SLOT_OFFER_TTL_MS,
): offer is BookingSlotOffer {
  if (!offer?.fetchedAt || offer.days.length === 0) return false;
  const at = new Date(offer.fetchedAt).getTime();
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= ttlMs;
}

export function freshBookingSlotOffer(
  value: unknown,
  now = new Date(),
): BookingSlotOffer | null {
  const offer = parseBookingSlotOffer(value);
  return isFreshBookingSlotOffer(offer, now) ? offer : null;
}

export function parseBookingSlotOffer(value: unknown): BookingSlotOffer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const date = typeof v.date === 'string' ? v.date.trim() : '';
  const fetchedAt = typeof v.fetchedAt === 'string' ? v.fetchedAt.trim() : '';
  if (!date || !fetchedAt) return null;

  const daysRaw = Array.isArray(v.days) ? v.days : [];
  const days: BookingSlotOfferDay[] = [];
  for (const row of daysRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const d = typeof r.date === 'string' ? r.date.trim() : '';
    if (!d || !Array.isArray(r.times)) continue;
    const times = r.times.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (times.length === 0) continue;
    days.push({ date: d, times });
  }
  if (days.length === 0) return null;

  const servicesRaw = Array.isArray(v.services) ? v.services : [];
  const services: BookingSlotOfferService[] = [];
  for (const row of servicesRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    const durationMin =
      typeof r.durationMin === 'number' && Number.isFinite(r.durationMin) ? r.durationMin : 60;
    const masterId = typeof r.masterId === 'string' && r.masterId.trim() ? r.masterId.trim() : undefined;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
    services.push({ id, durationMin, masterId, name });
  }

  const masterIds = Array.isArray(v.masterIds)
    ? v.masterIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const masterId =
    typeof v.masterId === 'string' && v.masterId.trim() ? v.masterId.trim() : undefined;

  return { date, days, services, masterId, masterIds, fetchedAt };
}

export function formatBookingSlotOfferForPrompt(offer: BookingSlotOffer): string {
  const dayLines = offer.days.map((d) => `- ${d.date}: ${d.times.join(', ')}`);
  const svc = offer.services
    .map((s) => s.name?.trim() || s.id.slice(0, 8))
    .join(', ');
  return [
    'Запропоновані вікна (ще дійсні — не вигадуй інші години):',
    `Дата запиту слотів: ${offer.date}`,
    ...dayLines,
    svc ? `Послуги: ${svc}` : '',
    'Якщо клієнт обрав одну з цих годин (або «перший/другий слот», «як ти писала») — одразу book_appointment, БЕЗ нового get_available_slots.',
    'Новий get_available_slots лише коли змінили послугу, дату чи майстра, або book повернув SLOT_NOT_AVAILABLE / TIME_CONFLICT / MASTER_DAY_CLOSED.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Keep previously offered clock times if they are still in CRM, then fill up to `cap`.
 */
export function pickSlotTimesForDay<T extends { time: string }>(
  slots: T[],
  cap: number,
  preferTimes?: string[],
): T[] {
  if (cap <= 0 || slots.length === 0) return [];
  const byKey = new Map<string, T>();
  for (const slot of slots) {
    const key = normalizeSlotTimeKey(slot.time);
    if (!byKey.has(key)) byKey.set(key, slot);
  }
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const raw of preferTimes ?? []) {
    const key = normalizeSlotTimeKey(raw);
    const hit = byKey.get(key);
    if (!hit || seen.has(key)) continue;
    picked.push(hit);
    seen.add(key);
    if (picked.length >= cap) return picked;
  }
  for (const slot of slots) {
    const key = normalizeSlotTimeKey(slot.time);
    if (seen.has(key)) continue;
    picked.push(slot);
    seen.add(key);
    if (picked.length >= cap) break;
  }
  return picked;
}

export function preferTimesForDate(
  offer: BookingSlotOffer | null | undefined,
  requestedDate: string,
): string[] | undefined {
  if (!offer) return undefined;
  const exact = offer.days.find((d) => d.date === requestedDate);
  if (exact) return exact.times;
  if (offer.date === requestedDate) return offer.days[0]?.times;
  return undefined;
}
