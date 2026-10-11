/**
 * Pure Altegio payload mapping. Live API is v1; ids are positive integers
 * stored as strings on the platform contract.
 */

import type { CrmServiceItem, CrmSlot, CrmVisitHistoryItem } from './types.js';

export type AltegioStaffRow = {
  id: string;
  name: string;
  positionNames: string[];
  bookable: boolean;
};

export type AltegioServiceRow = CrmServiceItem & {
  seanceSec: number;
};

export type AltegioWebhookPlan =
  | { action: 'ignore'; reason: string }
  | {
      action: 'cancel_record';
      recordId: string;
      companyId: string | null;
    }
  | {
      action: 'update_record';
      recordId: string;
      companyId: string | null;
      dateUa?: string;
      time?: string;
    }
  | {
      action: 'update_client';
      clientId: string;
      name?: string;
      companyId: string | null;
    };

export function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? n : null;
  }
  return null;
}

export function unwrapList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const inner = data as Record<string, unknown>;
    for (const key of ['services', 'staff', 'clients', 'records']) {
      if (Array.isArray(inner[key])) return inner[key] as unknown[];
    }
  }
  return [];
}

export function unwrapRecord(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) {
    const first = data[0];
    return first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : {};
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return json as Record<string, unknown>;
}

function flagOn(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function isBookableStaff(raw: Record<string, unknown>): boolean {
  if (flagOn(raw.fired) || flagOn(raw.hidden) || flagOn(raw.is_fired)) return false;
  if (raw.bookable === false || raw.is_bookable === false || raw.bookable === 0) return false;
  if (raw.status === 'fired' || raw.status === 'deleted') return false;
  return asPositiveInt(raw.id) != null;
}

export function mapStaff(raw: Record<string, unknown>): AltegioStaffRow | null {
  const id = asPositiveInt(raw.id);
  if (!id) return null;
  const name = stringField(raw.name) || stringField(raw.title);
  if (!name) return null;
  const spec = stringField(raw.specialization);
  const position =
    raw.position && typeof raw.position === 'object'
      ? stringField((raw.position as { title?: unknown }).title)
      : stringField(raw.position);
  const positionNames = [spec, position].filter((v, i, arr) => v && arr.indexOf(v) === i);
  return {
    id: String(id),
    name,
    positionNames,
    bookable: isBookableStaff(raw),
  };
}

/** Catalog duration: seance_length is seconds; bare duration ≥ 300 is seconds too. */
export function durationMinFromRaw(raw: Record<string, unknown>): { min: number; sec: number } {
  const seance = Number(raw.seance_length);
  if (Number.isFinite(seance) && seance >= 60) {
    const sec = Math.round(seance);
    return { min: Math.max(5, Math.round(sec / 60)), sec };
  }
  const duration = Number(raw.duration ?? raw.length);
  if (Number.isFinite(duration) && duration >= 300) {
    const sec = Math.round(duration);
    return { min: Math.max(5, Math.round(sec / 60)), sec };
  }
  if (Number.isFinite(duration) && duration > 0) {
    const min = Math.max(5, Math.round(duration));
    return { min, sec: min * 60 };
  }
  return { min: 60, sec: 3600 };
}

export function servicePrice(raw: Record<string, unknown>): number {
  const min = Number(raw.price_min);
  if (Number.isFinite(min) && min > 0) return min;
  const price = Number(raw.price);
  if (Number.isFinite(price) && price > 0) return price;
  const max = Number(raw.price_max);
  if (Number.isFinite(max) && max > 0) return max;
  return 0;
}

export type JsonApiResource = {
  type?: string;
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { type?: string; id?: string } | Array<{ type?: string; id?: string }> }>;
};

export function jsonApiResources(json: unknown): JsonApiResource[] {
  if (!json || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) return data.filter(isJsonApiResource);
  if (isJsonApiResource(data)) return [data];
  return [];
}

export function jsonApiIncluded(json: unknown): JsonApiResource[] {
  if (!json || typeof json !== 'object') return [];
  const included = (json as { included?: unknown }).included;
  if (!Array.isArray(included)) return [];
  return included.filter(isJsonApiResource);
}

function isJsonApiResource(value: unknown): value is JsonApiResource {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** B2B v2 attendance service: one row per service × team member. */
export function mapAttendanceService(
  resource: JsonApiResource,
  locationId: string,
): AltegioServiceRow | null {
  const attrs = resource.attributes ?? {};
  const id = asPositiveInt(attrs.service_id) ?? asPositiveInt(resource.id);
  const name = stringField(attrs.title) || stringField(attrs.name);
  if (!id || !name) return null;
  const durationSec = Number(attrs.duration ?? attrs.length);
  const sec = Number.isFinite(durationSec) && durationSec >= 60 ? Math.round(durationSec) : 3600;
  const min = Math.max(5, Math.round(sec / 60));
  const price = servicePrice(attrs);
  return {
    id: String(id),
    name,
    price,
    durationMin: min,
    seanceSec: sec,
    branchPrices: [{ branchId: locationId, branchName: '', price }],
  };
}

export function mergeAttendanceServices(
  rows: AltegioServiceRow[],
): AltegioServiceRow[] {
  const byId = new Map<string, AltegioServiceRow>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, row);
      continue;
    }
    if (row.price > 0 && (existing.price === 0 || row.price < existing.price)) {
      existing.price = row.price;
      existing.branchPrices = row.branchPrices;
    }
  }
  return [...byId.values()];
}

export function mapTeamMemberResource(
  resource: JsonApiResource,
  included: JsonApiResource[] = [],
): AltegioStaffRow | null {
  const id = asPositiveInt(resource.id);
  const attrs = resource.attributes ?? {};
  const name = stringField(attrs.name);
  if (!id || !name) return null;
  const spec = stringField(attrs.specialization);
  const positionId = relationshipId(resource, 'position');
  const position = included.find(
    (item) => item.type === 'position' && item.id === positionId,
  );
  const positionTitle = stringField(position?.attributes?.title);
  const positionNames = [spec, positionTitle].filter((value, index, all) => value && all.indexOf(value) === index);
  return {
    id: String(id),
    name,
    positionNames,
    bookable: true,
  };
}

export function mapHistoryResource(
  resource: JsonApiResource,
  included: JsonApiResource[] = [],
): CrmVisitHistoryItem | null {
  const id = asPositiveInt(resource.id);
  const attrs = resource.attributes ?? {};
  const clock = wallClockFromAltegio(stringField(attrs.date) || stringField(attrs.datetime));
  if (!id || !clock) return null;
  if (attrs.attendance_status_slug === 'absent') return null;
  const durationSec = Number(attrs.duration ?? attrs.length);
  const durationMin = Number.isFinite(durationSec) && durationSec >= 60
    ? Math.max(5, Math.round(durationSec / 60))
    : 60;
  const staffId = asPositiveInt(attrs.staff_id) ?? asPositiveInt(attrs.master_id);
  const staff = included.find(
    (item) => (item.type === 'staff' || item.type === 'team_member') && item.id === String(staffId ?? ''),
  );
  const serviceIds = relationshipIds(resource, 'services');
  const items = serviceIds
    .map((serviceId) => includedService(included, serviceId))
    .filter((item): item is JsonApiResource => item != null)
    .map((item) => ({
      id: item.id,
      name: stringField(item.attributes?.title) || stringField(item.attributes?.name) || 'Послуга',
      type: 'service',
    }));
  return {
    id: String(id),
    date: clock.dateUa,
    durationMin,
    bookedDurationMin: durationMin,
    professionalId: staffId ? String(staffId) : undefined,
    professionalName: stringField(staff?.attributes?.name) || undefined,
    items,
  };
}

function relationshipId(resource: JsonApiResource, name: string): string | null {
  const data = resource.relationships?.[name]?.data;
  if (!data || Array.isArray(data)) return null;
  return typeof data.id === 'string' ? data.id : null;
}

function includedService(
  included: JsonApiResource[],
  serviceId: string,
): JsonApiResource | undefined {
  const matches = included.filter((item) => item.id === serviceId);
  return (
    matches.find((item) => /service/i.test(item.type ?? ''))
    ?? matches[0]
  );
}

function relationshipIds(resource: JsonApiResource, name: string): string[] {
  const data = resource.relationships?.[name]?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (typeof item.id === 'string' ? item.id : ''))
    .filter((id) => id.length > 0);
}

export function mapService(
  raw: Record<string, unknown>,
  locationId: string,
): AltegioServiceRow | null {
  const id = asPositiveInt(raw.id);
  const name = stringField(raw.title) || stringField(raw.name);
  if (!id || !name) return null;
  const { min, sec } = durationMinFromRaw(raw);
  const price = servicePrice(raw);
  const category =
    raw.category && typeof raw.category === 'object'
      ? stringField((raw.category as { title?: unknown }).title)
      : stringField(raw.category_title);
  return {
    id: String(id),
    name,
    price,
    durationMin: min,
    seanceSec: sec,
    categoryName: category || undefined,
    branchPrices: [{ branchId: locationId, branchName: '', price }],
  };
}

export function formatAltegioDatetime(
  dateIso: string,
  time: string,
  timeZone: string,
): string {
  const hhmm = time.trim().slice(0, 5);
  const localDateStr = `${dateIso}T${hhmm}:00`;
  const tentativeUTC = new Date(`${localDateStr}Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(tentativeUTC);
  const kyivH = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const kyivM = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const utcH = tentativeUTC.getUTCHours();
  const utcM = tentativeUTC.getUTCMinutes();
  let diff = (kyivH * 60 + kyivM) - (utcH * 60 + utcM);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  const sign = diff >= 0 ? '+' : '-';
  const abs = Math.abs(diff);
  const offsetH = String(Math.floor(abs / 60)).padStart(2, '0');
  const offsetM = String(abs % 60).padStart(2, '0');
  return `${localDateStr}.000${sign}${offsetH}:${offsetM}`;
}

export function isoToUaDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

export function addIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

/** How far `fullMonth` looks past the requested day. Inclusive end is this many days later. */
export const ALTEGIO_MONTH_HORIZON_DAYS = 31;

/**
 * A named day stays that day (every free time comes back from book_times).
 * A month lookup looks at least a month forward, with or without a master.
 */
export function altegioSlotDateTo(dateIso: string, fullMonth: boolean): string {
  if (!fullMonth) return dateIso;
  return addIsoDays(dateIso, ALTEGIO_MONTH_HORIZON_DAYS);
}

/** Every bookable master, unless the client already picked one. */
export function selectAltegioStaff<T extends { id: string }>(
  staff: T[],
  masterId?: string,
): T[] {
  const id = masterId?.trim();
  if (!id) return staff;
  return staff.filter((row) => row.id === id);
}

export function sortSlotsByDate(slots: Record<string, CrmSlot[]>): Record<string, CrmSlot[]> {
  const sorted = Object.entries(slots).sort(([left], [right]) =>
    slotDateSortKey(left).localeCompare(slotDateSortKey(right)),
  );
  return Object.fromEntries(sorted);
}

function slotDateSortKey(date: string): string {
  const ua = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  if (!ua) return date;
  return `${ua[3]}-${ua[2]}-${ua[1]}`;
}

export function wallClockFromAltegio(raw: string): { dateUa: string; time: string } | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  return { dateUa: `${m[3]}.${m[2]}.${m[1]}`, time: `${m[4]}:${m[5]}` };
}

export function slotTime(raw: Record<string, unknown>): string | null {
  const time = stringField(raw.time);
  if (time && /^\d{2}:\d{2}/.test(time)) return time.slice(0, 5);
  const datetime = stringField(raw.datetime);
  if (!datetime) return null;
  const clock = wallClockFromAltegio(datetime);
  return clock?.time ?? null;
}

export function mergeSlots(
  rows: Array<{ dateIso: string; time: string; staffId: string }>,
): Record<string, CrmSlot[]> {
  const byKey = new Map<string, CrmSlot>();
  for (const row of rows) {
    const date = isoToUaDate(row.dateIso);
    const key = `${date}|${row.time}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.masterIds.includes(row.staffId)) existing.masterIds.push(row.staffId);
      continue;
    }
    byKey.set(key, { date, time: row.time, masterIds: [row.staffId] });
  }
  const slots: Record<string, CrmSlot[]> = {};
  for (const slot of byKey.values()) {
    const list = slots[slot.date] ?? [];
    list.push(slot);
    slots[slot.date] = list;
  }
  for (const list of Object.values(slots)) {
    list.sort((a, b) => a.time.localeCompare(b.time));
  }
  return slots;
}

export function bookingDatesFrom(json: unknown): { booking: string[]; working: string[] } {
  const data = unwrapRecord(json);
  const booking = stringList(data.booking_dates);
  const working = stringList(data.working_dates);
  return { booking, working };
}

export function visitWindow(services: Array<{ startTime: string; durationMin: number }>): {
  start: string;
  seconds: number;
} {
  const parsed = services
    .map((service) => {
      const match = /^(\d{1,2}):(\d{2})/.exec(service.startTime.trim());
      if (!match) return null;
      const startMin = Number(match[1]) * 60 + Number(match[2]);
      const duration = Number.isFinite(service.durationMin) ? Math.max(0, service.durationMin) : 0;
      return {
        startMin,
        endMin: startMin + duration,
        time: `${String(match[1]).padStart(2, '0')}:${match[2]}`,
      };
    })
    .filter((row): row is { startMin: number; endMin: number; time: string } => row != null);
  if (!parsed.length) {
    return { start: '00:00', seconds: 3600 };
  }
  const startMin = Math.min(...parsed.map((row) => row.startMin));
  const endMin = Math.max(...parsed.map((row) => row.endMin));
  const start = parsed.find((row) => row.startMin === startMin)?.time ?? '00:00';
  return { start, seconds: Math.max(15 * 60, (endMin - startMin) * 60) };
}

export function uniqueStaffIds(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.map((id) => id?.trim()).filter((id): id is string => Boolean(id)))];
}

export type AltegioRecordService = {
  id: number;
  cost: number;
  seanceSec: number;
};

export function buildCreateRecordBody(input: {
  staffId: number;
  services: AltegioRecordService[];
  client: { phone: string; name: string; id?: number };
  datetime: string;
  comment?: string;
  saveIfBusy: boolean;
  seanceSec: number;
  apiId: string;
}): Record<string, unknown> {
  const client: Record<string, unknown> = {
    phone: input.client.phone.trim(),
    name: input.client.name.trim(),
  };
  if (input.client.id && input.client.id > 0) client.id = input.client.id;
  return {
    staff_id: input.staffId,
    services: input.services.map((service) => ({
      id: service.id,
      first_cost: service.cost,
      discount: 0,
      cost: service.cost,
    })),
    client,
    save_if_busy: input.saveIfBusy,
    datetime: input.datetime,
    seance_length: input.seanceSec,
    send_sms: false,
    attendance: 0,
    api_id: input.apiId,
    comment: (input.comment ?? '').trim().slice(0, 500),
  };
}

export function extractCreatedIds(json: unknown): { recordId: string; clientId?: string } | null {
  const row = unwrapRecord(json);
  const recordId = asPositiveInt(row.id);
  if (!recordId) return null;
  const client = row.client;
  const clientRaw =
    client && typeof client === 'object'
      ? (client as { id?: unknown }).id
      : row.client_id;
  const clientId = asPositiveInt(clientRaw);
  return { recordId: String(recordId), clientId: clientId ? String(clientId) : undefined };
}

export function mapHistoryRecord(raw: Record<string, unknown>): CrmVisitHistoryItem | null {
  const id = asPositiveInt(raw.id);
  const datetime = stringField(raw.datetime) || stringField(raw.date);
  const clock = datetime ? wallClockFromAltegio(datetime) : null;
  if (!id || !clock) return null;
  if (flagOn(raw.deleted)) return null;
  const { min } = durationMinFromRaw(raw);
  const staff = raw.staff && typeof raw.staff === 'object'
    ? (raw.staff as Record<string, unknown>)
    : null;
  const staffId = asPositiveInt(raw.staff_id) ?? (staff ? asPositiveInt(staff.id) : null);
  const services = Array.isArray(raw.services) ? raw.services : [];
  return {
    id: String(id),
    date: clock.dateUa,
    durationMin: min,
    bookedDurationMin: min,
    professionalId: staffId ? String(staffId) : undefined,
    professionalName: staff ? stringField(staff.name) || undefined : undefined,
    items: services
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const name = stringField(row.title) || stringField(row.name);
        if (!name) return null;
        const serviceId = asPositiveInt(row.id);
        return {
          id: serviceId ? String(serviceId) : undefined,
          name,
          type: 'service',
          sum: servicePrice(row) || undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item != null),
  };
}

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function phonesMatch(a: string, b: string): boolean {
  const left = phoneDigits(a);
  const right = phoneDigits(b);
  if (!left || !right) return false;
  const tail = (value: string) => (value.length > 9 ? value.slice(-9) : value);
  return tail(left) === tail(right);
}

export function planAltegioWebhook(body: unknown): AltegioWebhookPlan {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { action: 'ignore', reason: 'empty' };
  }
  const root = body as Record<string, unknown>;
  const resource = stringField(root.resource).toLowerCase();
  const status = stringField(root.status ?? root.event_status).toLowerCase();
  const event = stringField(root.event ?? root.event_type).toLowerCase();
  const name = event || (resource && status ? `${resource}.${status}` : '');
  const data =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const companyId =
    idString(root.company_id)
    ?? idString(root.salon_id)
    ?? idString(data.company_id)
    ?? idString(data.salon_id);

  if (!name || name === 'install' || name === 'uninstall') {
    return { action: 'ignore', reason: name || 'unknown_event' };
  }

  if (/^(record|appointment)\.(delete|deleted|cancel|cancelled)$/.test(name)) {
    const recordId = asPositiveInt(data.id) ?? asPositiveInt(data.record_id);
    if (!recordId) return { action: 'ignore', reason: 'delete_without_id' };
    return { action: 'cancel_record', recordId: String(recordId), companyId };
  }

  if (/^(record|appointment)\.(create|created|update|updated)$/.test(name)) {
    const recordId = asPositiveInt(data.id) ?? asPositiveInt(data.record_id);
    if (!recordId) return { action: 'ignore', reason: 'record_without_id' };
    const datetime = stringField(data.datetime) || stringField(data.date);
    const clock = datetime ? wallClockFromAltegio(datetime) : null;
    return {
      action: 'update_record',
      recordId: String(recordId),
      companyId,
      dateUa: clock?.dateUa,
      time: clock?.time,
    };
  }

  if (/^client\.(update|updated|create|created)$/.test(name)) {
    const clientId = asPositiveInt(data.id) ?? asPositiveInt(data.client_id);
    if (!clientId) return { action: 'ignore', reason: 'client_without_id' };
    return {
      action: 'update_client',
      clientId: String(clientId),
      name: stringField(data.name) || stringField(data.display_name) || undefined,
      companyId,
    };
  }

  return { action: 'ignore', reason: name };
}

export function altegioWebhookAllowed(input: {
  bodyPartnerToken?: string;
  presentedSecret?: string;
  savedPartnerToken: string;
  savedWebhookSecret: string;
}): { ok: true } | { ok: false; reason: string } {
  const partner = input.bodyPartnerToken?.trim() ?? '';
  const presented = input.presentedSecret?.trim() ?? '';
  if (input.savedWebhookSecret) {
    if (!presented || !secretEquals(presented, input.savedWebhookSecret)) {
      return { ok: false, reason: 'webhook_secret' };
    }
  } else if (!partner || !secretEquals(partner, input.savedPartnerToken)) {
    return { ok: false, reason: 'partner_token' };
  }
  if (partner && !secretEquals(partner, input.savedPartnerToken)) {
    return { ok: false, reason: 'partner_token' };
  }
  return { ok: true };
}

export function secretEquals(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function idString(value: unknown): string | null {
  const n = asPositiveInt(value);
  return n ? String(n) : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
