/**
 * Open booking funnel — survives civil-day Claude history cuts and 2h slot-offer TTL.
 * Structured state for overnight “send name/phone to finish booking”.
 */

import { normalizeSlotTimeKey } from './booking-time-conflict.js';
import { civilSessionGapDays } from './claude-history-window.js';
import type { BookingSlotOffer } from './booking-slot-offer.js';

/** Funnel stays valid overnight; slot *listing* offer remains 2h. */
export const BOOKING_FUNNEL_TTL_MS = 36 * 60 * 60 * 1000;

export type BookingFunnelStatus = 'offering' | 'awaiting_contact';

export type BookingFunnelMissing = 'name' | 'phone';

export type BookingFunnelService = {
  id: string;
  durationMin: number;
  masterId?: string;
  name?: string;
};

export type BookingFunnel = {
  status: BookingFunnelStatus;
  date: string;
  time?: string;
  masterId?: string;
  masterName?: string;
  services: BookingFunnelService[];
  missing: BookingFunnelMissing[];
  updatedAt: string;
};

export function isFreshBookingFunnel(
  funnel: BookingFunnel | null | undefined,
  now = new Date(),
  ttlMs = BOOKING_FUNNEL_TTL_MS,
): funnel is BookingFunnel {
  if (!funnel?.updatedAt || !funnel.date || funnel.services.length === 0) return false;
  const at = Date.parse(funnel.updatedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= ttlMs;
}

export function freshBookingFunnel(value: unknown, now = new Date()): BookingFunnel | null {
  const funnel = parseBookingFunnel(value);
  return isFreshBookingFunnel(funnel, now) ? funnel : null;
}

export function parseBookingFunnel(value: unknown): BookingFunnel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const date = typeof v.date === 'string' ? v.date.trim() : '';
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt.trim() : '';
  if (!date || !updatedAt) return null;

  const statusRaw = typeof v.status === 'string' ? v.status.trim() : '';
  const status: BookingFunnelStatus =
    statusRaw === 'awaiting_contact' ? 'awaiting_contact' : 'offering';

  const servicesRaw = Array.isArray(v.services) ? v.services : [];
  const services: BookingFunnelService[] = [];
  for (const row of servicesRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    const durationMin =
      typeof r.durationMin === 'number' && Number.isFinite(r.durationMin) ? r.durationMin : 60;
    const masterId =
      typeof r.masterId === 'string' && r.masterId.trim() ? r.masterId.trim() : undefined;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
    services.push({ id, durationMin, masterId, name });
  }
  if (services.length === 0) return null;

  const time =
    typeof v.time === 'string' && v.time.trim()
      ? normalizeSlotTimeKey(v.time.trim())
      : undefined;
  const masterId =
    typeof v.masterId === 'string' && v.masterId.trim() ? v.masterId.trim() : undefined;
  const masterName =
    typeof v.masterName === 'string' && v.masterName.trim()
      ? v.masterName.trim()
      : undefined;

  const missingRaw = Array.isArray(v.missing) ? v.missing : [];
  const missing: BookingFunnelMissing[] = [];
  for (const m of missingRaw) {
    if (m === 'name' || m === 'phone') {
      if (!missing.includes(m)) missing.push(m);
    }
  }

  return {
    status,
    date,
    time,
    masterId,
    masterName,
    services,
    missing,
    updatedAt,
  };
}

/** Build/refresh funnel from a slot offer (status offering; keep selection if same date). */
export function funnelFromSlotOffer(
  offer: BookingSlotOffer,
  prev: BookingFunnel | null | undefined,
  now = new Date(),
): BookingFunnel {
  const sameDate = prev?.date === offer.date;
  const keepSelection =
    sameDate &&
    prev?.status === 'awaiting_contact' &&
    prev.time &&
    offer.days.some((d) =>
      d.date === offer.date
        ? (d.slots ?? d.times.map((t) => ({ time: t, masterIds: [] as string[] }))).some(
            (s) => normalizeSlotTimeKey(s.time) === normalizeSlotTimeKey(prev.time!),
          )
        : false,
    );

  return {
    status: keepSelection ? 'awaiting_contact' : 'offering',
    date: offer.date,
    time: keepSelection ? prev!.time : undefined,
    masterId: keepSelection ? prev!.masterId : offer.masterId,
    masterName: keepSelection
      ? prev!.masterName
      : offer.masters?.find((m) => m.id === offer.masterId)?.name,
    services: offer.services.map((s) => ({
      id: s.id,
      durationMin: s.durationMin,
      masterId: s.masterId,
      name: s.name,
    })),
    missing: keepSelection ? prev!.missing : ['name', 'phone'],
    updatedAt: now.toISOString(),
  };
}

export function funnelFromBookArgs(params: {
  date: string;
  time: string;
  services: BookingFunnelService[];
  masterId?: string;
  masterName?: string;
  missing: BookingFunnelMissing[];
  now?: Date;
}): BookingFunnel {
  return {
    status: 'awaiting_contact',
    date: params.date,
    time: normalizeSlotTimeKey(params.time),
    masterId: params.masterId,
    masterName: params.masterName,
    services: params.services,
    missing: params.missing.length > 0 ? params.missing : ['name', 'phone'],
    updatedAt: (params.now ?? new Date()).toISOString(),
  };
}

/**
 * If client text mentions a clock time present in the offer (or funnel days),
 * return an awaiting_contact funnel with that selection.
 */
export function applyTimeSelectionFromClientText(params: {
  text: string;
  offer: BookingSlotOffer | null;
  funnel: BookingFunnel | null;
  now?: Date;
}): BookingFunnel | null {
  const now = params.now ?? new Date();
  const base =
    params.funnel && isFreshBookingFunnel(params.funnel, now)
      ? params.funnel
      : params.offer
        ? funnelFromSlotOffer(params.offer, params.funnel, now)
        : null;
  if (!base) return null;

  const timesInText = extractClockTimesFromText(params.text);
  if (timesInText.length === 0) return null;

  const candidates = collectSelectableSlots(params.offer, base);
  if (candidates.length === 0) return null;

  for (const wanted of timesInText) {
    const hit = candidates.find((c) => c.timeKey === wanted);
    if (!hit) continue;
    return {
      ...base,
      status: 'awaiting_contact',
      date: hit.date,
      time: hit.timeKey,
      masterId: hit.masterId ?? base.masterId,
      masterName: hit.masterName ?? base.masterName,
      missing: base.missing.length > 0 ? base.missing : ['name', 'phone'],
      updatedAt: now.toISOString(),
    };
  }
  return null;
}

function extractClockTimesFromText(text: string): string[] {
  const out: string[] = [];
  const re = /\b([01]?\d|2[0-3])[:\.]([0-5]\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = normalizeSlotTimeKey(`${m[1]}:${m[2]}`);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function collectSelectableSlots(
  offer: BookingSlotOffer | null,
  funnel: BookingFunnel,
): Array<{ date: string; timeKey: string; masterId?: string; masterName?: string }> {
  const out: Array<{ date: string; timeKey: string; masterId?: string; masterName?: string }> =
    [];
  if (offer) {
    for (const day of offer.days) {
      const slots =
        (day.slots?.length ?? 0) > 0
          ? day.slots!
          : day.times.map((time) => ({ time, masterIds: [] as string[] }));
      for (const slot of slots) {
        const timeKey = normalizeSlotTimeKey(slot.time);
        const masterId = slot.masterIds[0] ?? offer.masterId ?? funnel.masterId;
        const masterName =
          (masterId && offer.masters?.find((m) => m.id === masterId)?.name) ||
          funnel.masterName;
        out.push({ date: day.date, timeKey, masterId, masterName });
      }
    }
  } else if (funnel.time) {
    out.push({
      date: funnel.date,
      timeKey: normalizeSlotTimeKey(funnel.time),
      masterId: funnel.masterId,
      masterName: funnel.masterName,
    });
  }
  return out;
}

export function funnelAgeLabel(
  funnel: BookingFunnel,
  now: Date,
  timeZone: string,
): string {
  const updated = new Date(funnel.updatedAt);
  if (Number.isNaN(updated.getTime())) return 'нещодавно';
  const gapDays = civilSessionGapDays(updated, now, timeZone);
  if (gapDays >= 1) {
    if (gapDays === 1) return 'почато вчора';
    return `почато ${gapDays} дн. тому`;
  }
  const hours = Math.max(0, Math.round((now.getTime() - updated.getTime()) / (60 * 60 * 1000)));
  if (hours <= 0) return 'щойно';
  if (hours === 1) return 'почато ~1 год тому';
  return `почато ~${hours} год тому`;
}

export function formatBookingFunnelForPrompt(
  funnel: BookingFunnel,
  now: Date,
  timeZone: string,
): string {
  const age = funnelAgeLabel(funnel, now, timeZone);
  const svc = funnel.services
    .map((s) => {
      const name = s.name?.trim() || 'послуга';
      const mid = s.masterId ? ` master_id=${s.masterId}` : '';
      return `- [service_id=${s.id}] ${name} | ${s.durationMin} хв${mid}`;
    })
    .join('\n');
  const masterLine = funnel.masterId
    ? `Майстер: ${funnel.masterName?.trim() || '—'} [master_id=${funnel.masterId}]`
    : funnel.masterName
      ? `Майстер: ${funnel.masterName}`
      : null;
  const slotLine = funnel.time
    ? `Обрано: ${funnel.date} о ${funnel.time}`
    : `Дата зі слотів: ${funnel.date} (час ще не обрано)`;
  const missing =
    funnel.missing.length > 0
      ? `Бракує для book_appointment: ${funnel.missing.join(', ')}`
      : 'Контакти можуть уже бути в профілі — перевір «Імʼя:» / «Телефон:».';

  const closeRule =
    funnel.status === 'awaiting_contact' && funnel.time
      ? 'Якщо клієнт щойно надіслав імʼя/телефон (або вони вже в «Вже відомо») і не змінив послугу/дату/час — у ТІЙ САМІЙ відповіді book_appointment з ids вище. НЕ search_services, НЕ get_available_slots, НЕ питай знову «на яку послугу / який день».'
      : 'Клієнт ще обирає годину з запропонованих / цього funnel. Після вибору години + контактів — book_appointment.';

  return [
    `Незавершений запис (${age}; статус: ${funnel.status}):`,
    slotLine,
    masterLine,
    'Послуги (повні id для tools):',
    svc,
    missing,
    closeRule,
    'Це НЕ новий запит — civil-day історія могла обрізати вчорашні репліки; спирайся на цей блок.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Drop stale funnel when past TTL (for store clear). */
export function isBookingFunnelExpired(value: unknown, now = new Date()): boolean {
  const funnel = parseBookingFunnel(value);
  if (!funnel) return true;
  return !isFreshBookingFunnel(funnel, now);
}
