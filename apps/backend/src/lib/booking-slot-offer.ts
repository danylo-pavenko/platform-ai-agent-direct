import { normalizeSlotTimeKey } from './booking-time-conflict.js';

/** Keep the last slot offer for slow IG contact collection after times were shown. */
export const BOOKING_SLOT_OFFER_TTL_MS = 2 * 60 * 60 * 1000;

export type BookingSlotOfferSlot = {
  time: string;
  masterIds: string[];
};

export type BookingSlotOfferDay = {
  date: string;
  times: string[];
  slots?: BookingSlotOfferSlot[];
};

export type BookingSlotOfferService = {
  id: string;
  durationMin: number;
  masterId?: string;
  name?: string;
};

export type BookingSlotOfferMaster = {
  id: string;
  name: string;
};

export type BookingSlotOffer = {
  date: string;
  days: BookingSlotOfferDay[];
  services: BookingSlotOfferService[];
  masterId?: string;
  masterIds: string[];
  masters?: BookingSlotOfferMaster[];
  fetchedAt: string;
};

function parseOfferSlots(
  times: string[],
  slotsRaw: unknown,
): BookingSlotOfferSlot[] {
  const fromSlots: BookingSlotOfferSlot[] = [];
  if (Array.isArray(slotsRaw)) {
    for (const row of slotsRaw) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const time = typeof r.time === 'string' ? r.time.trim() : '';
      if (!time) continue;
      const masterIds = Array.isArray(r.masterIds)
        ? r.masterIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];
      fromSlots.push({ time, masterIds });
    }
  }
  if (fromSlots.length > 0) return fromSlots;
  return times.map((time) => ({ time, masterIds: [] }));
}

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
    days.push({ date: d, times, slots: parseOfferSlots(times, r.slots) });
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

  const mastersRaw = Array.isArray(v.masters) ? v.masters : [];
  const masters: BookingSlotOfferMaster[] = [];
  for (const row of mastersRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
    masters.push({ id, name });
  }

  return { date, days, services, masterId, masterIds, masters, fetchedAt };
}

export function collectOfferCrmIds(offer: BookingSlotOffer | null | undefined): string[] {
  if (!offer) return [];
  const ids = new Set<string>();
  if (offer.masterId) ids.add(offer.masterId);
  for (const id of offer.masterIds) ids.add(id);
  for (const m of offer.masters ?? []) ids.add(m.id);
  for (const s of offer.services) {
    ids.add(s.id);
    if (s.masterId) ids.add(s.masterId);
  }
  for (const day of offer.days) {
    for (const slot of day.slots ?? []) {
      for (const id of slot.masterIds) ids.add(id);
    }
  }
  return [...ids];
}

export function collectOfferNameHints(
  offer: BookingSlotOffer | null | undefined,
): Array<{ id: string; name: string }> {
  if (!offer) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const m of offer.masters ?? []) {
    if (m.id.trim() && m.name.trim()) out.push({ id: m.id, name: m.name });
  }
  for (const s of offer.services) {
    if (s.id.trim() && s.name?.trim()) out.push({ id: s.id, name: s.name });
  }
  return out;
}

function masterName(offer: BookingSlotOffer, id: string): string {
  return offer.masters?.find((m) => m.id === id)?.name?.trim() || id;
}

export function formatBookingSlotOfferForPrompt(offer: BookingSlotOffer): string {
  const svcLines = offer.services.map((s) => {
    const name = s.name?.trim() || 'послуга';
    const master = s.masterId ? ` | master_id=${s.masterId}` : '';
    return `- [service_id=${s.id}] ${name} | ${s.durationMin} хв${master}`;
  });
  const masterLines =
    (offer.masters?.length ?? 0) > 0
      ? offer.masters!.map((m) => `- [master_id=${m.id}] ${m.name}`)
      : offer.masterIds.map((id) => `- [master_id=${id}]`);

  const dayLines: string[] = [];
  for (const d of offer.days) {
    const slots = (d.slots?.length ?? 0) > 0
      ? d.slots!
      : d.times.map((time) => ({ time, masterIds: [] as string[] }));
    for (const slot of slots) {
      const ids = slot.masterIds.length > 0 ? slot.masterIds : offer.masterIds;
      const masters =
        ids.length > 0
          ? ids.map((id) => `[master_id=${id}] ${masterName(offer, id)}`).join(', ')
          : '—';
      dayLines.push(`- ${d.date} ${slot.time} | ${masters}`);
    }
  }

  return [
    'Запропоновані вікна (ще дійсні — не вигадуй інші години; ids лише для tools):',
    `Дата запиту слотів: ${offer.date}`,
    svcLines.length > 0
      ? 'Послуги (book_appointment.services[].id — повний id з цього блоку: UUID BeautyPro або число CleverBOX, не обрізок і не імʼя):'
      : '',
    ...svcLines,
    masterLines.length > 0
      ? 'Майстри (book_appointment.master_id / services[].master_id — повний id з рядка слота, не імʼя):'
      : '',
    ...masterLines,
    'Слоти:',
    ...dayLines,
    'Якщо клієнт обрав одну з цих годин — book_appointment з service_id/master_id з ЦЬОГО блоку, БЕЗ нового get_available_slots.',
    'На годині кілька майстрів і клієнт не назвав кого — спитай, або бери перший master_id саме цього рядка (не з історії іншої послуги).',
    'Новий get_available_slots: змінили послугу/дату/майстра; клієнт просить інші години цього дня; або book повернув SLOT_NOT_AVAILABLE / TIME_CONFLICT / MASTER_DAY_CLOSED.',
    'Не кажи що інших годин немає лише тому, що в цьому блоці короткий список — це вибірка. Клієнту показуй лише імена й години, не id.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Spread `n` picks across the list (first…last), not only the earliest hours. */
export function evenSampleSlots<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return items;
  if (n === 1) return [items[0]];
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (items.length - 1)) / (n - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(items[idx]);
  }
  for (let i = 0; i < items.length && out.length < n; i++) {
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(items[i]);
  }
  return out;
}

/**
 * Keep previously offered clock times if they are still in CRM, then fill up to `cap`
 * by sampling across the day. A second lookup after a full slice rotates to unused hours.
 */
export function pickSlotTimesForDay<T extends { time: string }>(
  slots: T[],
  cap: number,
  preferTimes?: string[],
): T[] {
  if (cap <= 0 || slots.length === 0) return [];
  const unique: T[] = [];
  const byKey = new Map<string, T>();
  for (const slot of slots) {
    const key = normalizeSlotTimeKey(slot.time);
    if (byKey.has(key)) continue;
    byKey.set(key, slot);
    unique.push(slot);
  }
  const pinned: T[] = [];
  const pinnedKeys = new Set<string>();
  for (const raw of preferTimes ?? []) {
    const key = normalizeSlotTimeKey(raw);
    const hit = byKey.get(key);
    if (!hit || pinnedKeys.has(key)) continue;
    pinned.push(hit);
    pinnedKeys.add(key);
  }
  const unused = unique.filter((s) => !pinnedKeys.has(normalizeSlotTimeKey(s.time)));
  if (pinned.length >= cap && unused.length > 0) {
    return evenSampleSlots(unused, cap);
  }
  if (pinned.length >= cap) return pinned.slice(0, cap);
  const rest = evenSampleSlots(unused, cap - pinned.length);
  return [...pinned, ...rest];
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
