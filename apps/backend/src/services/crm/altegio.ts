/**
 * Altegio CRM adapter.
 *
 * Business reads and cancel go to B2B v2 (`/api/v2`): attendance services,
 * team members, appointment history, DELETE appointment.
 * Free slots and creating a visit stay on Online Booking / staff records
 * (`/api/v1` book_dates, book_times, POST /records) — v2 does not expose them.
 * v3 is still a preview.
 *
 * One record is one master. Reschedule is cancel + create.
 */

import pino from 'pino';
import { getAgentConfig } from '../../lib/agent-config.js';
import { getIntegrationConfig } from '../../lib/integration-config.js';
import { sanitizeIntegrationSecret } from '../../lib/integration-secrets.js';
import { createTtlCache } from '../../lib/ttl-cache.js';
import { DEFAULT_TENANT_TIMEZONE } from '../../lib/tenant-timezone.js';
import {
  clampServiceSearchLimit,
  rankServices,
} from '../../lib/service-search-rank.js';
import { filterSlotsByMasterId } from './slot-filter.js';
import {
  parseAgentDate,
  toIsoDate,
} from './beautypro-free-time.js';
import { AltegioClient, type AltegioAuth } from './altegio-http.js';
import {
  altegioSlotDateTo,
  selectAltegioStaff,
  sortSlotsByDate,
  asPositiveInt,
  bookingDatesFrom,
  buildCreateRecordBody,
  extractCreatedIds,
  jsonApiIncluded,
  jsonApiResources,
  mapAttendanceService,
  mapHistoryRecord,
  mapHistoryResource,
  mapService,
  mapStaff,
  mapTeamMemberResource,
  mergeAttendanceServices,
  mergeSlots,
  phonesMatch,
  slotTime,
  uniqueStaffIds,
  unwrapList,
  unwrapRecord,
  visitWindow,
  formatAltegioDatetime,
  type AltegioServiceRow,
  type AltegioStaffRow,
} from './altegio-map.js';
import type {
  CrmAdapter,
  CrmBookingAppendInput,
  CrmBookingInput,
  CrmBranch,
  CrmCategory,
  CrmClientInput,
  CrmClientMatch,
  CrmEmployee,
  CrmOffer,
  CrmProduct,
  CrmServiceItem,
  CrmSlot,
  CrmSlotQuery,
  CrmVisitHistoryItem,
  OfferSearchParams,
  ProductSearchParams,
} from './types.js';

const log = pino({ name: 'crm:altegio' });

const servicesCache = createTtlCache<AltegioServiceRow[]>(5 * 60_000);
const staffCache = createTtlCache<AltegioStaffRow[]>(5 * 60_000);
let cacheLocationId = '';

export type AltegioCredentials = AltegioAuth & { locationId: string };

export type AltegioConnectionTestResult = {
  ok: boolean;
  status: 'ok' | 'error';
  message: string;
  company?: { id: string; title: string; address?: string };
  staffCount?: number;
  serviceCount?: number;
};

function rememberLocation(locationId: string): void {
  if (cacheLocationId === locationId) return;
  servicesCache.clear();
  staffCache.clear();
  cacheLocationId = locationId;
}

export async function resolveAltegioCredentials(overrides?: {
  partnerToken?: string;
  userToken?: string;
  locationId?: string;
}): Promise<AltegioCredentials> {
  const { altegio } = await getIntegrationConfig({ fresh: true });
  const partnerToken =
    sanitizeIntegrationSecret(overrides?.partnerToken) || altegio.partnerToken;
  const userToken =
    sanitizeIntegrationSecret(overrides?.userToken) || altegio.userToken;
  const locationId = (overrides?.locationId?.trim() || altegio.locationId).trim();
  return { partnerToken, userToken, locationId };
}

async function requireCreds(): Promise<AltegioCredentials> {
  const creds = await resolveAltegioCredentials();
  if (!creds.partnerToken || !creds.userToken || !asPositiveInt(creds.locationId)) {
    throw new Error('Altegio: partner token, user token або location id не налаштовано');
  }
  rememberLocation(creds.locationId);
  return creds;
}

function clientFor(creds: AltegioCredentials): AltegioClient {
  return new AltegioClient({
    partnerToken: creds.partnerToken,
    userToken: creds.userToken,
  });
}

async function loadCompany(client: AltegioClient, locationId: string): Promise<CrmBranch> {
  try {
    const json = await client.b2bGet<unknown>(`locations/${locationId}`);
    const resource = jsonApiResources(json)[0];
    const attrs = resource?.attributes ?? {};
    const legacy = unwrapRecord(json);
    const title =
      stringField(attrs.title)
      || stringField(attrs.name)
      || stringField(legacy.title)
      || stringField(legacy.name);
    if (title) {
      return {
        id: locationId,
        name: title,
        address: stringField(attrs.address) || stringField(legacy.address) || undefined,
      };
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), locationId },
      'Altegio v2 location resource unavailable',
    );
  }
  return { id: locationId, name: `Локація ${locationId}` };
}

async function loadStaff(client: AltegioClient, locationId: string): Promise<AltegioStaffRow[]> {
  const cached = staffCache.get();
  if (cached) return cached;
  const json = await client.b2bGet<unknown>(`locations/${locationId}/team_members`, {
    'filter[fired]': 0,
    'filter[deleted]': 0,
    include: 'position',
  });
  const included = jsonApiIncluded(json);
  const resources = jsonApiResources(json);
  const rows = resources.length
    ? resources
      .map((resource) => mapTeamMemberResource(resource, included))
      .filter((row): row is AltegioStaffRow => row != null)
    : unwrapList(json)
      .map((row) => (row && typeof row === 'object' ? mapStaff(row as Record<string, unknown>) : null))
      .filter((row): row is AltegioStaffRow => row != null && row.bookable);
  staffCache.set(rows);
  return rows;
}

async function loadServices(
  client: AltegioClient,
  locationId: string,
): Promise<AltegioServiceRow[]> {
  const cached = servicesCache.get();
  if (cached) return cached;
  const pageSize = 100;
  const mapped: AltegioServiceRow[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const json = await client.b2bGet<unknown>(`locations/${locationId}/attendance_services`, {
      page,
      limit: pageSize,
    });
    const resources = jsonApiResources(json);
    if (!resources.length && page === 1) {
      const legacy = unwrapList(json)
        .map((row) =>
          row && typeof row === 'object'
            ? mapService(row as Record<string, unknown>, locationId)
            : null,
        )
        .filter((row): row is AltegioServiceRow => row != null);
      mapped.push(...legacy);
      break;
    }
    for (const resource of resources) {
      const row = mapAttendanceService(resource, locationId);
      if (row) mapped.push(row);
    }
    if (resources.length < pageSize) break;
  }
  const rows = mergeAttendanceServices(mapped);
  servicesCache.set(rows);
  return rows;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

type DayProbe = {
  dateIso: string;
  staffId: string;
  booking: boolean;
  working: boolean;
  times: string[];
  error?: string;
};

async function probeStaffDay(
  client: AltegioClient,
  locationId: string,
  staffId: string,
  dateIso: string,
  dateTo: string,
  serviceIds: number[],
): Promise<DayProbe[]> {
  const query: Record<string, unknown> = {
    staff_id: staffId,
    date_from: dateIso,
    date_to: dateTo,
  };
  if (serviceIds.length) query.service_ids = serviceIds.map(String);
  const datesJson = await client.get<unknown>(`book_dates/${locationId}`, query);
  const { booking, working } = bookingDatesFrom(datesJson);
  const wanted = booking.filter((day) => day >= dateIso && day <= dateTo);
  const timesByDay = await mapPool(wanted, 3, async (day) => {
    const timesQuery: Record<string, unknown> = {};
    if (serviceIds.length) timesQuery.service_ids = serviceIds.map(String);
    const timesJson = await client.get<unknown>(
      `book_times/${locationId}/${staffId}/${day}`,
      timesQuery,
    );
    const times = unwrapList(timesJson)
      .map((row) =>
        row && typeof row === 'object' ? slotTime(row as Record<string, unknown>) : null,
      )
      .filter((time): time is string => Boolean(time));
    return { day, times };
  });
  const timeMap = new Map(timesByDay.map((row) => [row.day, row.times]));
  const days = new Set([...booking, ...working, dateIso]);
  return [...days]
    .filter((day) => day >= dateIso && day <= dateTo)
    .map((day) => ({
      dateIso: day,
      staffId,
      booking: booking.includes(day),
      working: working.includes(day),
      times: timeMap.get(day) ?? [],
    }));
}

async function readSlots(
  client: AltegioClient,
  locationId: string,
  query: CrmSlotQuery,
): Promise<{
  slots: Record<string, CrmSlot[]>;
  masters: Array<{ id: string; name: string }>;
  probed: DayProbe[];
}> {
  const parts = parseAgentDate(query.date);
  if (!parts) throw new Error('Altegio: дата має бути ДД.ММ.РРРР');
  const dateIso = toIsoDate(parts);
  const dateTo = altegioSlotDateTo(dateIso, query.fullMonth === true);
  const serviceIds = query.services
    .map((service) => asPositiveInt(service.id))
    .filter((id): id is number => id != null);

  const staff = (await loadStaff(client, locationId)).filter((row) => row.bookable);
  const selected = selectAltegioStaff(staff, query.masterId);
  const targets = selected.length ? selected : query.masterId
    ? [{ id: query.masterId, name: query.masterId, positionNames: [], bookable: true }]
    : [];

  const probedNested = await mapPool(targets, 3, async (row) => {
    try {
      return await probeStaffDay(client, locationId, row.id, dateIso, dateTo, serviceIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ staffId: row.id, err: message }, 'Altegio book_times failed');
      return [{
        dateIso,
        staffId: row.id,
        booking: false,
        working: false,
        times: [],
        error: message,
      } satisfies DayProbe];
    }
  });
  const probed = probedNested.flat();
  const slotRows = probed.flatMap((day) =>
    day.times.map((time) => ({ dateIso: day.dateIso, time, staffId: day.staffId })),
  );
  const merged = mergeSlots(slotRows);
  const filtered = query.masterId
    ? filterSlotsByMasterId({ slots: merged, masters: [] }, query.masterId).slots
    : merged;
  const slots = sortSlotsByDate(filtered);
  return {
    slots,
    masters: targets.map((row) => ({ id: row.id, name: row.name })),
    probed,
  };
}

function assertSlotOpen(probed: DayProbe[], dateIso: string, time: string, staffId: string): void {
  const rows = probed.filter((row) => row.staffId === staffId && row.dateIso === dateIso);
  const day = rows[0];
  if (!day || day.error) {
    throw new Error(day?.error || 'Altegio не повернув графік майстра');
  }
  if (!day.booking && !day.working) {
    throw new Error('MASTER_DAY_CLOSED: у майстра немає відкритого дня в Altegio');
  }
  if (!day.times.includes(time.slice(0, 5))) {
    throw new Error('SLOT_NOT_AVAILABLE: цей час відсутній у графіку Altegio');
  }
}

async function findClientId(
  client: AltegioClient,
  locationId: string,
  phone: string,
): Promise<{ id: string; name?: string } | null> {
  const json = await client.post<unknown>(`company/${locationId}/clients/search`, {
    page: 1,
    page_size: 20,
    fields: ['id', 'name', 'phone'],
    filters: [{ type: 'quick_search', state: { value: phone } }],
  });
  const rows = unwrapList(json);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = asPositiveInt(record.id);
    const rowPhone = stringField(record.phone);
    if (id && rowPhone && phonesMatch(rowPhone, phone)) {
      return { id: String(id), name: stringField(record.name) || undefined };
    }
  }
  return null;
}

async function getRecord(
  client: AltegioClient,
  locationId: string,
  recordId: string,
): Promise<Record<string, unknown>> {
  const json = await client.get<unknown>(`record/${locationId}/${recordId}`);
  return unwrapRecord(json);
}

export async function testAltegioConnection(overrides?: {
  partnerToken?: string;
  userToken?: string;
  locationId?: string;
}): Promise<AltegioConnectionTestResult> {
  const creds = await resolveAltegioCredentials(overrides);
  if (!creds.partnerToken || !creds.userToken || !asPositiveInt(creds.locationId)) {
    return {
      ok: false,
      status: 'error',
      message: 'Потрібні partner token, user token і числовий ID компанії Altegio',
    };
  }
  const client = clientFor(creds);
  rememberLocation(creds.locationId);
  try {
    const company = await loadCompany(client, creds.locationId);
    const staff = await loadStaff(client, creds.locationId);
    const services = await loadServices(client, creds.locationId);
    const bookable = staff.filter((row) => row.bookable).length;
    return {
      ok: true,
      status: 'ok',
      message: `Підключено: ${company.name}. Майстрів: ${bookable}, послуг: ${services.length}.`,
      company: { id: company.id, title: company.name, address: company.address },
      staffCount: bookable,
      serviceCount: services.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 'error', message };
  }
}

export const altegioAdapter: CrmAdapter = {
  name: 'altegio',
  capabilities: {
    catalog: false,
    services: true,
    branches: true,
    orders: false,
    leads: false,
    booking: true,
  },

  async fetchCategories(): Promise<CrmCategory[]> {
    return [];
  },
  async fetchProducts(): Promise<CrmProduct[]> {
    return [];
  },
  async fetchOffers(): Promise<CrmOffer[]> {
    return [];
  },
  async searchProducts(_params: ProductSearchParams): Promise<CrmProduct[]> {
    return [];
  },
  async searchOffers(_params: OfferSearchParams): Promise<CrmOffer[]> {
    return [];
  },

  async fetchBranches(): Promise<CrmBranch[]> {
    const creds = await requireCreds();
    return [await loadCompany(clientFor(creds), creds.locationId)];
  },

  async fetchServices(): Promise<CrmServiceItem[]> {
    const creds = await requireCreds();
    return loadServices(clientFor(creds), creds.locationId);
  },

  async fetchEmployees(): Promise<CrmEmployee[]> {
    const creds = await requireCreds();
    const staff = await loadStaff(clientFor(creds), creds.locationId);
    return staff
      .filter((row) => row.bookable)
      .map((row) => ({
        id: row.id,
        name: row.name,
        public: true,
        positionNames: row.positionNames,
      }));
  },

  async searchServices(query: string, limit?: number): Promise<CrmServiceItem[]> {
    const services = await this.fetchServices!();
    return rankServices(services, query, clampServiceSearchLimit(limit));
  },

  async getAvailableSlots(query: CrmSlotQuery) {
    const creds = await requireCreds();
    const { slots, masters } = await readSlots(clientFor(creds), creds.locationId, query);
    return { slots, masters };
  },

  async findClient(match: CrmClientMatch) {
    if (!match.phone) return null;
    const creds = await requireCreds();
    try {
      const found = await findClientId(clientFor(creds), creds.locationId, match.phone);
      if (!found) return null;
      return { crmBuyerId: found.id, fullName: found.name };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Altegio client search failed',
      );
      return null;
    }
  },

  async upsertClient(crmBuyerId: string | null, input: CrmClientInput) {
    const creds = await requireCreds();
    const client = clientFor(creds);
    const existing = asPositiveInt(crmBuyerId);
    if (existing) return { crmBuyerId: String(existing) };
    if (input.phone) {
      try {
        const found = await findClientId(client, creds.locationId, input.phone);
        if (found) return { crmBuyerId: found.id };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Altegio client search before create failed',
        );
      }
    }
    const json = await client.post<unknown>(`company/${creds.locationId}/clients`, {
      name: input.fullName?.trim() || 'Клієнт',
      phone: input.phone?.trim() || '',
      email: input.email?.trim() || undefined,
    });
    const created = asPositiveInt(unwrapRecord(json).id);
    if (!created) throw new Error('Altegio не повернув id клієнта');
    return { crmBuyerId: String(created) };
  },

  async createBooking(input: CrmBookingInput) {
    const creds = await requireCreds();
    const client = clientFor(creds);
    const staffIds = uniqueStaffIds(input.services.map((service) => service.masterId));
    if (staffIds.length === 0) {
      throw new Error('Altegio: book потребує master_id з get_available_slots');
    }
    if (staffIds.length > 1) {
      throw new Error(
        'ALTEGIO_ONE_MASTER: в Altegio один запис = один майстер. Послуги різних майстрів запишіть окремими book_appointment.',
      );
    }
    const staffId = asPositiveInt(staffIds[0]);
    if (!staffId) throw new Error('Altegio: book потребує числовий master_id');

    const parts = parseAgentDate(input.date);
    if (!parts) throw new Error('Altegio: дата має бути ДД.ММ.РРРР');
    const dateIso = toIsoDate(parts);
    const catalog = await loadServices(client, creds.locationId);
    const byId = new Map(catalog.map((service) => [service.id, service]));
    const lines = input.services.map((service) => {
      const known = byId.get(service.id);
      const durationMin = service.durationMin > 0 ? service.durationMin : known?.durationMin ?? 60;
      return {
        id: asPositiveInt(service.id),
        durationMin,
        startTime: service.startTime,
        cost: known?.price ?? 0,
        seanceSec: known?.seanceSec ?? durationMin * 60,
      };
    });
    if (lines.some((line) => !line.id)) {
      throw new Error('Altegio: service id має бути числом з search_services');
    }
    const window = visitWindow(
      lines.map((line) => ({ startTime: line.startTime, durationMin: line.durationMin })),
    );

    if (!input.skipScheduleCheck) {
      const probe = await readSlots(client, creds.locationId, {
        date: input.date,
        branchId: creds.locationId,
        masterId: String(staffId),
        services: lines.map((line) => ({ id: String(line.id), durationMin: line.durationMin })),
      });
      assertSlotOpen(probe.probed, dateIso, window.start, String(staffId));
    }

    const agent = await getAgentConfig();
    const timeZone = agent.timezone || DEFAULT_TENANT_TIMEZONE;
    let clientId = asPositiveInt(input.clientId) ?? undefined;
    if (!clientId && input.phone) {
      try {
        const found = await findClientId(client, creds.locationId, input.phone);
        if (found) clientId = Number(found.id);
      } catch {
        clientId = undefined;
      }
    }

    const body = buildCreateRecordBody({
      staffId,
      services: lines.map((line) => ({
        id: line.id!,
        cost: line.cost,
        seanceSec: line.seanceSec,
      })),
      client: {
        phone: input.phone,
        name: input.clientName,
        id: clientId,
      },
      datetime: formatAltegioDatetime(dateIso, window.start, timeZone),
      comment: input.comment,
      saveIfBusy: input.forceTimeConflict === true,
      seanceSec: window.seconds,
      apiId: `platform_${Date.now()}`,
    });

    const json = await client.post<unknown>(`records/${creds.locationId}`, body);
    const created = extractCreatedIds(json);
    if (!created) throw new Error('Altegio не повернув id запису');
    return {
      crmRecordId: created.recordId,
      crmBuyerId: created.clientId,
      comment: input.comment,
    };
  },

  async cancelBooking(recordId: string, _reason?: 'move' | 'cancel') {
    const id = asPositiveInt(recordId);
    if (!id) throw new Error('Altegio: crm record id має бути числом');
    const creds = await requireCreds();
    await clientFor(creds).b2bDelete(
      `locations/${creds.locationId}/appointments/${id}`,
    );
  },

  async fetchAppointmentServices(crmRecordId: string) {
    const creds = await requireCreds();
    const row = await getRecord(clientFor(creds), creds.locationId, crmRecordId);
    const staffId = asPositiveInt(row.staff_id);
    const services = Array.isArray(row.services) ? row.services : [];
    return services
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const service = item as Record<string, unknown>;
        const serviceId = asPositiveInt(service.id);
        if (!serviceId) return null;
        return {
          lineId: String(serviceId),
          serviceId: String(serviceId),
          serviceName: stringField(service.title) || stringField(service.name) || undefined,
          professionalId: staffId ? String(staffId) : undefined,
          durationMin: durationGuess(service),
        };
      })
      .filter((line): line is NonNullable<typeof line> => line != null);
  },

  async removeBookingService(input: { crmRecordId: string; serviceCatalogId: string }) {
    const creds = await requireCreds();
    const client = clientFor(creds);
    const row = await getRecord(client, creds.locationId, input.crmRecordId);
    const services = (Array.isArray(row.services) ? row.services : []).filter((item) => {
      if (!item || typeof item !== 'object') return false;
      return String(asPositiveInt((item as { id?: unknown }).id) ?? '') !== input.serviceCatalogId;
    });
    if (services.length === 0) {
      const id = asPositiveInt(input.crmRecordId);
      if (!id) throw new Error('Altegio: crm record id має бути числом');
      await client.b2bDelete(`locations/${creds.locationId}/appointments/${id}`);
      return { remainingCount: 0, cancelledVisit: true };
    }
    await client.put(`record/${creds.locationId}/${input.crmRecordId}`, {
      ...recordUpdateBase(row),
      services: services.map(servicePayload),
    });
    return { remainingCount: services.length, cancelledVisit: false };
  },

  async appendBookingServices(input: CrmBookingAppendInput) {
    const creds = await requireCreds();
    const client = clientFor(creds);
    const staffIds = uniqueStaffIds(input.services.map((service) => service.masterId));
    if (staffIds.length > 1) {
      throw new Error(
        'ALTEGIO_ONE_MASTER: в Altegio не можна додати послугу іншого майстра в той самий запис.',
      );
    }
    const row = await getRecord(client, creds.locationId, input.crmRecordId);
    const catalog = await loadServices(client, creds.locationId);
    const byId = new Map(catalog.map((service) => [service.id, service]));
    const services = input.services.map((service) => {
      const id = asPositiveInt(service.id);
      if (!id) throw new Error('Altegio: service id має бути числом');
      const known = byId.get(String(id));
      return {
        id,
        first_cost: known?.price ?? 0,
        discount: 0,
        cost: known?.price ?? 0,
      };
    });
    const window = visitWindow(
      input.services.map((service) => ({
        startTime: service.startTime || input.startTime,
        durationMin: service.durationMin,
      })),
    );
    await client.put(`record/${creds.locationId}/${input.crmRecordId}`, {
      ...recordUpdateBase(row),
      seance_length: window.seconds,
      services,
    });
  },

  async fetchClientHistory(crmBuyerId: string, opts?: { limit?: number }): Promise<CrmVisitHistoryItem[]> {
    const clientId = asPositiveInt(crmBuyerId);
    if (!clientId) return [];
    const creds = await requireCreds();
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);
    const json = await clientFor(creds).b2bGet<unknown>(`locations/${creds.locationId}/appointments`, {
      'filter[client_id]': String(clientId),
      'filter[date_intersect_from]': `${startIso}T00:00:00`,
      'filter[date_intersect_to]': `${endIso}T23:59:59`,
      include: ['services', 'staff'],
      page: 1,
      limit: Math.min(50, opts?.limit ?? 20),
    });
    const included = jsonApiIncluded(json);
    const resources = jsonApiResources(json);
    if (resources.length) {
      return resources
        .map((resource) => mapHistoryResource(resource, included))
        .filter((row): row is CrmVisitHistoryItem => row != null);
    }
    return unwrapList(json)
      .map((row) =>
        row && typeof row === 'object'
          ? mapHistoryRecord(row as Record<string, unknown>)
          : null,
      )
      .filter((row): row is CrmVisitHistoryItem => row != null);
  },
};

function recordUpdateBase(row: Record<string, unknown>): Record<string, unknown> {
  const staffId = asPositiveInt(row.staff_id);
  return {
    staff_id: staffId ?? undefined,
    datetime: stringField(row.datetime) || undefined,
    seance_length: asPositiveInt(row.seance_length) ?? undefined,
    comment: stringField(row.comment) || undefined,
  };
}

function servicePayload(item: unknown): Record<string, unknown> {
  const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  const id = asPositiveInt(row.id);
  const cost = Number(row.cost ?? row.price ?? 0);
  return {
    id,
    first_cost: Number.isFinite(cost) ? cost : 0,
    discount: Number(row.discount ?? 0) || 0,
    cost: Number.isFinite(cost) ? cost : 0,
  };
}

function durationGuess(raw: Record<string, unknown>): number | undefined {
  const seance = Number(raw.seance_length ?? raw.duration);
  if (!Number.isFinite(seance) || seance <= 0) return undefined;
  return seance >= 300 ? Math.round(seance / 60) : Math.round(seance);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
