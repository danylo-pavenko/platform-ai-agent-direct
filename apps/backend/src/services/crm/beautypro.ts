/**
 * BeautyPro / Fitness Pro / Denta Pro CRM adapter (AI Helps API).
 * Docs: https://aihelpssoft.github.io/documentations/
 *
 * Auth: application_id + secret + database_code → Database token (24h) + refresh.
 * Salon: locations, services, employees/free_time, appointments, clients.
 */

import pino from 'pino';
import { prisma } from '../../lib/prisma.js';
import { getIntegrationConfig, invalidateIntegrationConfigCache } from '../../lib/integration-config.js';
import { sanitizeIntegrationSecret } from '../../lib/integration-secrets.js';
import { config } from '../../config.js';
import type {
  CrmAdapter,
  CrmBookingAppendInput,
  CrmBookingInput,
  CrmBranch,
  CrmCategory,
  CrmClientInput,
  CrmClientMatch,
  CrmOffer,
  CrmProduct,
  CrmServiceItem,
  CrmSlotQuery,
  CrmVisitHistoryItem,
  OfferSearchParams,
  ProductSearchParams,
} from './types.js';
import { filterSlotsByMasterId } from './slot-filter.js';
import { createTtlCache } from '../../lib/ttl-cache.js';
import {
  clampServiceSearchLimit,
  DEFAULT_SERVICE_SEARCH_LIMIT,
  rankServices,
} from '../../lib/service-search-rank.js';
import {
  assertFreeTimePayload,
  buildFreeTimeQueryParams,
  invertFreeTime,
  parseAgentDate,
  toIsoDate,
  type FreeTimeResponse,
} from './beautypro-free-time.js';
import {
  buildBeautyproAppointmentAppendServicesBody,
  buildBeautyproAppointmentCreateBody,
  isBeautyproTimeConflictError,
  normalizeBeautyproStartTime,
  pickSameDayAppointmentId,
} from './beautypro-appointment.js';
import {
  BP_CLIENT_LIST_FIELDS,
  buildBeautyproClientWriteBody,
  buildClientPhoneSearchVariants,
  buildIgNameSearchVariants,
  normalizeIgUsername,
  pickClientMatchingIg,
  type RawClientLike,
} from './beautypro-clients.js';
import { computeActualDurationMin } from '../../lib/client-service-duration.js';

const log = pino({ name: 'crm:beautypro' });

/** Max sales to resolve per history fetch (avoid API spam). */
const HISTORY_SALE_LOOKUP_CAP = 8;

const AUTH_HOST = 'https://api.aihelps.com/v1';

function apiHostForServer(server: number): string {
  if (server === 4) return 'https://api4.aihelps.com/v1';
  return 'https://api.aihelps.com/v1';
}

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  apiServer: number;
  authStatus: 'pending' | 'granted' | 'refused' | '';
}

interface RawLocation {
  id: string;
  name: string;
  city?: string | null;
  street?: string | null;
  phone?: string | null;
  timezone?: string | null;
  active?: boolean;
}

interface RawService {
  id: string;
  name: string;
  description?: string | null;
  duration?: number;
  category?: string | null;
  public?: boolean;
  archive?: boolean;
  location_prices?: Array<{
    location: string;
    /** Professional grade / position UUID (client price per master level). */
    position?: string | null;
    price?: number | null;
    staff_price?: number | null;
  }>;
  no_professional_price?: number | null;
}

interface RawCategory {
  id: string;
  name: string;
}

interface RawPosition {
  id: string;
  name: string;
}

interface RawEmployee {
  id: string;
  name: string;
  archive?: boolean;
  public?: boolean;
  roles?: string | string[];
  positions?: string | string[] | null;
  position_names?: string | string[] | null;
}

interface RawClient {
  id: string;
  name?: string;
  firstname?: string;
  lastname?: string;
  phone?: string[] | string | null;
  email?: string[] | string | null;
  comment?: string | null;
}

function splitClientName(fullName: string): { firstname: string; lastname: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstname: 'Client', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0]!, lastname: '' };
  return { firstname: parts[0]!, lastname: parts.slice(1).join(' ') };
}

async function loadCredentials(): Promise<{
  applicationId: string;
  applicationSecret: string;
  databaseCode: string;
  tokens: TokenState;
}> {
  const { beautypro } = await getIntegrationConfig();
  const applicationId = beautypro.applicationId || config.BEAUTYPRO_APPLICATION_ID;
  const applicationSecret =
    beautypro.applicationSecret || config.BEAUTYPRO_APPLICATION_SECRET;
  const databaseCode = beautypro.databaseCode || config.BEAUTYPRO_DATABASE_CODE;

  if (!applicationId || !applicationSecret || !databaseCode) {
    throw new Error(
      'BeautyPro not configured (applicationId, applicationSecret, databaseCode required)',
    );
  }

  return {
    applicationId,
    applicationSecret,
    databaseCode,
    tokens: {
      accessToken: beautypro.accessToken,
      refreshToken: beautypro.refreshToken,
      expiresAt: beautypro.tokenExpiresAt,
      apiServer: beautypro.apiServer || 1,
      authStatus: beautypro.authStatus,
    },
  };
}

async function persistTokens(patch: Partial<TokenState>): Promise<void> {
  const creds = await loadCredentials();
  const { beautypro } = await getIntegrationConfig({ fresh: true });
  const next = {
    applicationId: creds.applicationId,
    applicationSecret: creds.applicationSecret,
    databaseCode: creds.databaseCode,
    defaultLocationId: beautypro.defaultLocationId || config.BEAUTYPRO_DEFAULT_LOCATION_ID,
    syncIntervalMin: beautypro.syncIntervalMin || config.BEAUTYPRO_SYNC_INTERVAL_MIN,
    accessToken: patch.accessToken ?? beautypro.accessToken,
    refreshToken: patch.refreshToken ?? beautypro.refreshToken,
    tokenExpiresAt: patch.expiresAt ?? beautypro.tokenExpiresAt,
    apiServer: patch.apiServer ?? beautypro.apiServer ?? 1,
    authStatus: patch.authStatus ?? beautypro.authStatus,
  };

  await prisma.setting.upsert({
    where: { key: 'integration_beautypro' },
    create: { key: 'integration_beautypro', value: next },
    update: { value: next },
  });
  invalidateIntegrationConfigCache();
}

function tokenStillValid(expiresAt: string): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  // Refresh 5 minutes before expiry
  return ms - Date.now() > 5 * 60_000;
}

async function requestDatabaseToken(
  applicationId: string,
  applicationSecret: string,
  databaseCode: string,
): Promise<TokenState> {
  const url = new URL(`${AUTH_HOST}/auth/database`);
  url.searchParams.set('application_id', applicationId);
  url.searchParams.set('application_secret', applicationSecret);
  url.searchParams.set('database_code', databaseCode);

  const res = await fetch(url.toString(), { method: 'GET' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(
      `BeautyPro auth/database HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }

  if (typeof body.status === 'string') {
    const status = body.status === 'refused' ? 'refused' : 'pending';
    await persistTokens({ authStatus: status });
    throw new Error(
      status === 'refused'
        ? 'BeautyPro access refused — check Marketplace permissions'
        : 'BeautyPro access pending — grant in BeautyPro → Settings → Marketplace',
    );
  }

  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  if (!accessToken) {
    throw new Error('BeautyPro auth/database returned no access_token');
  }

  const tokens: TokenState = {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
    expiresAt:
      typeof body.expires_at === 'string'
        ? body.expires_at
        : new Date(Date.now() + 23 * 3600_000).toISOString(),
    apiServer: typeof body.server === 'number' ? body.server : 1,
    authStatus: 'granted',
  };
  await persistTokens(tokens);
  return tokens;
}

async function refreshAccessToken(
  applicationId: string,
  refreshToken: string,
): Promise<TokenState> {
  const url = new URL(`${AUTH_HOST}/auth/refresh`);
  url.searchParams.set('application_id', applicationId);
  url.searchParams.set('refresh_token', refreshToken);

  const res = await fetch(url.toString(), { method: 'GET' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(
      `BeautyPro auth/refresh HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }

  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  if (!accessToken) {
    throw new Error('BeautyPro auth/refresh returned no access_token');
  }

  const tokens: TokenState = {
    accessToken,
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
    expiresAt:
      typeof body.expires_at === 'string'
        ? body.expires_at
        : new Date(Date.now() + 23 * 3600_000).toISOString(),
    apiServer: 0, // keep previous via persist merge — set below
    authStatus: 'granted',
  };

  const { tokens: prev } = await loadCredentials();
  tokens.apiServer = prev.apiServer || 1;
  await persistTokens(tokens);
  return tokens;
}

async function ensureAccessToken(): Promise<{ accessToken: string; apiServer: number }> {
  const { applicationId, applicationSecret, databaseCode, tokens } =
    await loadCredentials();

  if (tokens.accessToken && tokenStillValid(tokens.expiresAt)) {
    return { accessToken: tokens.accessToken, apiServer: tokens.apiServer || 1 };
  }

  if (tokens.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(applicationId, tokens.refreshToken);
      return { accessToken: refreshed.accessToken, apiServer: refreshed.apiServer || 1 };
    } catch (err) {
      log.warn({ err }, 'BeautyPro refresh failed — requesting new database token');
    }
  }

  const issued = await requestDatabaseToken(
    applicationId,
    applicationSecret,
    databaseCode,
  );
  return { accessToken: issued.accessToken, apiServer: issued.apiServer || 1 };
}

async function bpFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts?: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    retryAuth?: boolean;
  },
): Promise<T> {
  const { accessToken, apiServer } = await ensureAccessToken();
  const base = apiHostForServer(apiServer);
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts?.query ?? {})) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && opts?.retryAuth !== false) {
    // Force re-auth once
    const { applicationId, applicationSecret, databaseCode, tokens } =
      await loadCredentials();
    if (tokens.refreshToken) {
      await refreshAccessToken(applicationId, tokens.refreshToken).catch(async () => {
        await requestDatabaseToken(applicationId, applicationSecret, databaseCode);
      });
    } else {
      await requestDatabaseToken(applicationId, applicationSecret, databaseCode);
    }
    return bpFetch(method, path, { ...opts, retryAuth: false });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`BeautyPro ${method} ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function fetchCategoryMap(): Promise<Map<string, string>> {
  try {
    const cats = await bpFetch<RawCategory[]>('GET', '/services/categories', {
      query: { fields: 'name', archive: false },
    });
    const map = new Map<string, string>();
    for (const c of cats ?? []) {
      if (c.id && c.name) map.set(c.id, c.name);
    }
    return map;
  } catch (err) {
    log.warn({ err }, 'BeautyPro service categories fetch failed');
    return new Map();
  }
}

async function fetchPositionMap(): Promise<Map<string, string>> {
  try {
    const rows = await bpFetch<RawPosition[]>('GET', '/positions', {
      query: { fields: 'name', role: 'professional' },
    });
    const map = new Map<string, string>();
    for (const p of rows ?? []) {
      if (p.id && p.name) map.set(p.id, p.name);
    }
    return map;
  } catch (err) {
    log.warn({ err }, 'BeautyPro positions fetch failed');
    return new Map();
  }
}

function asIdList(value: string | string[] | null | undefined): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const s = String(value).trim();
  return s ? [s] : [];
}

/**
 * Map BeautyPro service + location_prices into CrmServiceItem with full grade matrix.
 * Exported for unit tests.
 */
export function mapBeautyproService(
  raw: RawService,
  categories: Map<string, string>,
  positions: Map<string, string>,
): CrmServiceItem {
  const prices = raw.location_prices ?? [];
  const priceRows = prices
    .map((p) => {
      const price = typeof p.price === 'number' ? p.price : 0;
      if (!(price > 0) || !p.location) return null;
      const positionId = p.position ? String(p.position) : undefined;
      return {
        branchId: p.location,
        positionId,
        positionName: positionId ? positions.get(positionId) : undefined,
        price,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  const noProPrice =
    typeof raw.no_professional_price === 'number' && raw.no_professional_price > 0
      ? raw.no_professional_price
      : 0;

  const clientPrices = priceRows.map((r) => r.price);
  const basePrice =
    noProPrice > 0
      ? noProPrice
      : clientPrices.length > 0
        ? Math.min(...clientPrices)
        : 0;

  // Aggregate per location (min–max collapsed to min for branchPrices.price;
  // Sync UI uses unique branch count from priceRows).
  const byBranch = new Map<string, number>();
  for (const row of priceRows) {
    const prev = byBranch.get(row.branchId);
    if (prev == null || row.price < prev) byBranch.set(row.branchId, row.price);
  }

  return {
    id: raw.id,
    name: raw.name,
    price: basePrice,
    durationMin: raw.duration ?? 60,
    categoryName: raw.category ? categories.get(raw.category) : undefined,
    branchPrices: [...byBranch.entries()].map(([branchId, price]) => ({
      branchId,
      branchName: branchId,
      price,
    })),
    priceRows: priceRows.length > 0 ? priceRows : undefined,
  };
}

function mapService(
  raw: RawService,
  categories: Map<string, string>,
  positions: Map<string, string>,
): CrmServiceItem {
  return mapBeautyproService(raw, categories, positions);
}

const servicesListCache = createTtlCache<CrmServiceItem[]>(3 * 60 * 1000);
const employeesListCache = createTtlCache<
  Array<{
    id: string;
    name: string;
    public?: boolean;
    positionIds?: string[];
    positionNames?: string[];
  }>
>(3 * 60 * 1000);

async function fetchAllServices(): Promise<CrmServiceItem[]> {
  const cached = servicesListCache.get();
  if (cached) return cached;

  const [raw, categories, positions] = await Promise.all([
    bpFetch<RawService[]>('GET', '/services', {
      query: {
        // Live API rejects `no_professional_price` in fields ("Unknown parameter")
        // even though older docs list it — prices come from location_prices.
        fields:
          'name,description,duration,category,public,location_prices,archive,price_currency',
        public: true,
        archive: false,
      },
    }),
    fetchCategoryMap(),
    fetchPositionMap(),
  ]);

  const items = (raw ?? [])
    .filter((s) => s.archive !== true)
    .map((s) => mapService(s, categories, positions));
  servicesListCache.set(items);
  return items;
}

async function fetchAllEmployees() {
  const cached = employeesListCache.get();
  if (cached) return cached;

  const rows = await bpFetch<RawEmployee[]>('GET', '/employees', {
    query: {
      fields: 'name,archive,public,roles,positions,position_names',
      role: 'professional',
      archive: false,
    },
  });

  const items = (rows ?? [])
    .filter((e) => e.archive !== true)
    .map((e) => {
      const positionIds = asIdList(e.positions);
      const positionNames = asIdList(e.position_names);
      return {
        id: e.id,
        name: e.name,
        public: e.public,
        positionIds: positionIds.length > 0 ? positionIds : undefined,
        positionNames: positionNames.length > 0 ? positionNames : undefined,
      };
    });
  employeesListCache.set(items);
  return items;
}

async function fetchFreeTimeWithFallbacks(query: CrmSlotQuery): Promise<FreeTimeResponse> {
  const attempts: Array<{
    label: string;
    nearestDayOnly: boolean;
    publicEmployees?: boolean;
    includeServices: boolean;
  }> = [
    {
      label: 'day_all_public',
      nearestDayOnly: false,
      publicEmployees: true,
      includeServices: true,
    },
    {
      label: 'day_all_employees',
      nearestDayOnly: false,
      publicEmployees: undefined,
      includeServices: true,
    },
    {
      label: 'day_no_service_filter',
      nearestDayOnly: false,
      publicEmployees: true,
      includeServices: false,
    },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    const params = buildFreeTimeQueryParams(query, {
      nearestDayOnly: attempt.nearestDayOnly,
      publicEmployees: attempt.publicEmployees,
      includeServices: attempt.includeServices,
    });
    try {
      const raw = await bpFetch<unknown>('GET', '/employees/free_time', { query: params });
      if (attempt.label !== 'day_all_public') {
        log.info(
          { attempt: attempt.label, date: query.date, location: query.branchId },
          'BeautyPro free_time succeeded on fallback',
        );
      }
      return assertFreeTimePayload(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.label}: ${message}`);
      log.warn(
        {
          err,
          attempt: attempt.label,
          date: query.date,
          location: query.branchId,
          services: query.services.map((s) => s.id),
          step: params.step,
        },
        'BeautyPro free_time attempt failed',
      );
      // Bad `step` / hard param errors won't change across our fallbacks — fail fast.
      if (/Parameter 'step'|invalid step|Unknown parameter/i.test(message)) {
        break;
      }
    }
  }

  throw new Error(
    `BeautyPro free_time failed after ${errors.length} attempts: ${errors.join(' | ')}`.slice(
      0,
      600,
    ),
  );
}

async function findSameDayClientAppointment(opts: {
  clientId: string;
  locationId: string;
  isoDate: string;
}): Promise<string | null> {
  try {
    const rows = await bpFetch<
      Array<{
        id: string;
        date?: string | null;
        location?: string | null;
        client?: string | null;
      }>
    >('GET', '/appointments', {
      query: {
        // Official GET fields have no `id` (always returned) and no `state`.
        fields: 'date,location,client',
        client: opts.clientId,
        location: opts.locationId,
        from: `${opts.isoDate}T00:00:00.000Z`,
        to: `${opts.isoDate}T23:59:59.999Z`,
        state: 'planned,confirmed',
      },
    });
    return pickSameDayAppointmentId(rows, opts);
  } catch (err) {
    log.warn({ err, ...opts }, 'BeautyPro same-day appointment lookup failed');
    return null;
  }
}

/**
 * For paid visits with sale_id, fetch sale_date and set actualDurationMin
 * (wall-clock start → payment close, as in BeautyPro UI history).
 */
async function enrichHistoryWithSaleDurations(
  visits: CrmVisitHistoryItem[],
): Promise<void> {
  const saleIds: string[] = [];
  const seen = new Set<string>();
  for (const visit of visits) {
    if (visit.paid !== true) continue;
    for (const it of visit.items) {
      const sid = it.saleId?.trim();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      saleIds.push(sid);
      if (saleIds.length >= HISTORY_SALE_LOOKUP_CAP) break;
    }
    if (saleIds.length >= HISTORY_SALE_LOOKUP_CAP) break;
  }
  if (saleIds.length === 0) return;

  const saleDates = new Map<string, string>();
  await Promise.all(
    saleIds.map(async (saleId) => {
      try {
        const sale = await bpFetch<{ sale_date?: string; duration?: number }>(
          'GET',
          `/sales/${saleId}`,
          { query: { fields: 'sale_date,duration,calendar_date' } },
        );
        if (typeof sale?.sale_date === 'string' && sale.sale_date.trim()) {
          saleDates.set(saleId, sale.sale_date.trim());
        }
      } catch (err) {
        log.warn({ err, saleId }, 'BeautyPro sale lookup failed (history duration)');
      }
    }),
  );

  for (const visit of visits) {
    if (!visit.date) continue;
    let bestActual: number | undefined;
    for (const it of visit.items) {
      const sid = it.saleId?.trim();
      if (!sid) continue;
      const saleDate = saleDates.get(sid);
      if (!saleDate) continue;
      const actual = computeActualDurationMin(visit.date, saleDate);
      if (actual == null) continue;
      if (bestActual == null || actual > bestActual) bestActual = actual;
    }
    if (bestActual == null) continue;
    visit.actualDurationMin = bestActual;
    visit.durationMin = bestActual;
    const booked = visit.bookedDurationMin ?? 0;
    if (booked > 0 && Math.abs(bestActual - booked) >= 5) {
      log.debug(
        {
          visitId: visit.id,
          booked,
          actual: bestActual,
        },
        'BeautyPro history: actual duration differs from booked',
      );
    }
  }
}

export const beautyproAdapter: CrmAdapter = {
  name: 'beautypro',
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
    const rows = await bpFetch<RawLocation[]>('GET', '/locations', {
      query: {
        // List endpoint documents only `fields` (no `active` filter — that is GET /locations/{id}).
        fields: 'name,city,street,phone,timezone,active',
      },
    });

    return (rows ?? [])
      .filter((l) => l.active !== false)
      .map((l) => ({
        id: l.id,
        name: l.name,
        address: [l.city, l.street].filter(Boolean).join(', ') || undefined,
        metadata: {
          phone: l.phone ?? undefined,
          timezone: l.timezone ?? undefined,
        },
      }));
  },

  async fetchServices(): Promise<CrmServiceItem[]> {
    return fetchAllServices();
  },

  async fetchEmployees() {
    return fetchAllEmployees();
  },

  async searchServices(
    query: string,
    limit = DEFAULT_SERVICE_SEARCH_LIMIT,
  ): Promise<CrmServiceItem[]> {
    const all = await fetchAllServices();
    return rankServices(all, query, clampServiceSearchLimit(limit));
  },

  async getAvailableSlots(query: CrmSlotQuery) {
    const free = await fetchFreeTimeWithFallbacks(query);
    const { slots, masterIds } = invertFreeTime(free);

    let masters: Array<{ id: string; name: string }> = [];
    if (masterIds.size > 0) {
      try {
        const employees = await bpFetch<RawEmployee[]>('GET', '/employees', {
          query: {
            fields: 'name,archive,public,roles',
            location: query.branchId,
            role: 'professional',
            archive: false,
          },
        });
        masters = (employees ?? [])
          .filter((e) => masterIds.has(e.id))
          .map((e) => ({ id: e.id, name: e.name }));
        // Ensure every free_time id has a label
        for (const id of masterIds) {
          if (!masters.some((m) => m.id === id)) {
            masters.push({ id, name: id });
          }
        }
      } catch (err) {
        log.warn({ err }, 'BeautyPro employees list failed — using raw ids');
        masters = [...masterIds].map((id) => ({ id, name: id }));
      }
    }

    return filterSlotsByMasterId({ slots, masters }, query.masterId);
  },

  async findClient(match: CrmClientMatch) {
    if (match.crmBuyerId) {
      return { crmBuyerId: match.crmBuyerId };
    }

    const tryPhone = async (phone: string): Promise<string | null> => {
      for (const variant of buildClientPhoneSearchVariants(phone)) {
        try {
          const rows = await bpFetch<RawClient[]>('GET', '/clients', {
            query: {
              fields: BP_CLIENT_LIST_FIELDS,
              phone: variant,
              archive: false,
            },
          });
          const hit = (rows ?? [])[0];
          if (hit?.id) return hit.id;
        } catch (err) {
          log.warn({ err, variant }, 'BeautyPro client phone lookup failed');
        }
      }
      return null;
    };

    const tryEmail = async (email: string): Promise<string | null> => {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return null;
      try {
        const rows = await bpFetch<RawClient[]>('GET', '/clients', {
          query: {
            fields: BP_CLIENT_LIST_FIELDS,
            email: normalized,
            archive: false,
          },
        });
        const hit = (rows ?? [])[0];
        return hit?.id ?? null;
      } catch (err) {
        log.warn({ err, email: normalized }, 'BeautyPro client email lookup failed');
        return null;
      }
    };

    /**
     * BeautyPro has no instagram filter. Match GET `comment` (salon-typed notes)
     * or name ≈ handle. We do not write IG onto the client card.
     */
    const tryInstagram = async (username: string): Promise<string | null> => {
      const handle = normalizeIgUsername(username);
      if (!handle) return null;
      for (const nameQ of buildIgNameSearchVariants(handle)) {
        try {
          const rows = await bpFetch<RawClientLike[]>('GET', '/clients', {
            query: {
              fields: BP_CLIENT_LIST_FIELDS,
              name: nameQ,
              archive: false,
            },
          });
          const hit = pickClientMatchingIg(rows, handle);
          if (hit?.id) return hit.id;
        } catch (err) {
          log.warn({ err, nameQ }, 'BeautyPro client IG/name lookup failed');
        }
      }
      return null;
    };

    if (match.phone) {
      const byPhone = await tryPhone(match.phone);
      if (byPhone) return { crmBuyerId: byPhone };
    }

    if (match.email) {
      const byEmail = await tryEmail(match.email);
      if (byEmail) return { crmBuyerId: byEmail };
    }

    if (match.instagramUsername) {
      const byIg = await tryInstagram(match.instagramUsername);
      if (byIg) return { crmBuyerId: byIg };
    }

    return null;
  },

  async upsertClient(crmBuyerId: string | null, input: CrmClientInput) {
    const { firstname, lastname } = splitClientName(input.fullName);
    const body = buildBeautyproClientWriteBody({
      mode: crmBuyerId ? 'update' : 'create',
      firstname,
      lastname,
      phone: input.phone,
      email: input.email,
    });
    // input.note / instagramUsername are not client write fields (live POST
    // 400s `comment`). Booking notes go on the appointment `comments`.

    if (crmBuyerId) {
      await bpFetch('PUT', `/clients/${crmBuyerId}`, { body });
      return { crmBuyerId };
    }

    const created = await bpFetch<{ id: string }>('POST', '/clients', {
      // Official POST example returns `{ id }`. Do not send `fields` or `id`.
      body,
    });

    if (!created?.id) {
      throw new Error('BeautyPro client create returned no id');
    }
    return { crmBuyerId: created.id };
  },

  async createBooking(input: CrmBookingInput) {
    const parts = parseAgentDate(input.date);
    if (!parts) {
      throw new Error(`BeautyPro: invalid booking date "${input.date}"`);
    }
    const isoDate = toIsoDate(parts);

    let clientId = input.clientId;
    if (!clientId) {
      const found = await beautyproAdapter.findClient!({ phone: input.phone });
      if (found) {
        clientId = found.crmBuyerId;
      } else {
        const created = await beautyproAdapter.upsertClient!(null, {
          fullName: input.clientName,
          phone: input.phone,
        });
        clientId = created.crmBuyerId;
      }
    }

    let professional =
      input.services.map((s) => s.masterId).find((id) => Boolean(id?.trim())) ?? undefined;
    if (!professional) {
      const serviceIds = input.services.map((s) => s.id).join(',');
      const loadCandidates = async (publicOnly: boolean | undefined) => {
        const rows = await bpFetch<RawEmployee[]>('GET', '/employees', {
          query: {
            fields: 'name,public,archive',
            location: input.branchId,
            ...(serviceIds ? { service: serviceIds } : {}),
            role: 'professional',
            archive: false,
            ...(publicOnly === true ? { public: true } : {}),
          },
        });
        return (rows ?? []).filter((e) => e.archive !== true).map((e) => e.id);
      };

      let candidates: string[] = [];
      try {
        candidates = await loadCandidates(true);
        if (candidates.length === 0) {
          candidates = await loadCandidates(undefined);
        }
      } catch (err) {
        log.warn({ err }, 'BeautyPro employees for booking failed');
        try {
          candidates = await loadCandidates(undefined);
        } catch {
          candidates = [];
        }
      }

      if (candidates.length > 0) {
        try {
          const picked = await bpFetch<{ professional: string }>(
            'GET',
            '/employees/pick_professional',
            {
              query: {
                date: isoDate,
                professionals: candidates.join(','),
              },
            },
          );
          professional = picked?.professional ?? candidates[0];
        } catch {
          professional = candidates[0];
        }
      }
    }

    if (!professional) {
      throw new Error('BeautyPro: no professional available for booking');
    }
    if (!clientId) {
      throw new Error('BeautyPro: client id missing after upsert');
    }

    const start = normalizeBeautyproStartTime(input.services[0]?.startTime ?? '10:00');
    const body = buildBeautyproAppointmentCreateBody({
      isoDate,
      locationId: input.branchId,
      clientId,
      comment: input.comment,
      professional,
      start,
      services: input.services,
    });

    // Do not pass `fields=id,...` — docs' POST fields list has no `id`, and the
    // live API returns 400 "Unknown parameter 'id'". Default 201 body is `{ id }`.
    // `force=true` skips TIME_CONFLICT (admin-only; agent never sets this).
    let created: { id: string; smsError?: unknown } | undefined;
    try {
      created = await bpFetch<{ id: string; smsError?: unknown }>('POST', '/appointments', {
        query: input.forceTimeConflict === true ? { force: true } : undefined,
        body,
      });
    } catch (err) {
      if (isBeautyproTimeConflictError(err) && input.forceTimeConflict !== true) {
        const existingId = await findSameDayClientAppointment({
          clientId,
          locationId: input.branchId,
          isoDate,
        });
        if (existingId) {
          log.info(
            { appointmentId: existingId, clientId, isoDate },
            'BeautyPro TIME_CONFLICT — linked existing same-day appointment',
          );
          return { crmRecordId: existingId, crmBuyerId: clientId };
        }
      }
      throw err;
    }

    if (!created?.id) {
      throw new Error('BeautyPro appointment create returned no id');
    }

    if (created.smsError) {
      log.warn({ smsError: created.smsError, id: created.id }, 'BeautyPro SMS warning');
    }

    log.info(
      { appointmentId: created.id, forceTimeConflict: input.forceTimeConflict === true },
      'BeautyPro booking created',
    );
    return { crmRecordId: created.id, crmBuyerId: clientId };
  },

  async appendBookingServices(input: CrmBookingAppendInput) {
    if (input.previousServiceCount >= input.services.length) return;

    let professional =
      input.services.map((s) => s.masterId).find((id) => Boolean(id?.trim())) ?? undefined;
    if (!professional) {
      throw new Error('BeautyPro: no professional for booking append');
    }

    const start = normalizeBeautyproStartTime(input.startTime);
    const body = buildBeautyproAppointmentAppendServicesBody({
      professional,
      start,
      allServices: input.services,
      previousServiceCount: input.previousServiceCount,
    });

    await bpFetch('PUT', `/appointments/${input.crmRecordId}`, { body });
    log.info(
      {
        crmRecordId: input.crmRecordId,
        previousServiceCount: input.previousServiceCount,
        totalServices: input.services.length,
      },
      'BeautyPro booking services appended',
    );
  },

  async cancelBooking(recordId: string, _reason?: 'move' | 'cancel') {
    await bpFetch('PUT', `/appointments/${recordId}`, {
      body: {
        state: 'cancelled',
        cancelReason: 'Cancelled via Instagram agent',
      },
    });
  },

  async fetchClientHistory(
    crmBuyerId: string,
    opts?: { limit?: number },
  ): Promise<CrmVisitHistoryItem[]> {
    const limit = opts?.limit ?? 15;
    const raw = await bpFetch<
      Array<{
        id: string;
        date?: string;
        duration?: number;
        professional?: string | null;
        professional_name?: string | null;
        paid?: boolean;
        items?: Array<{
          id?: string;
          name?: string;
          type?: string;
          quantity?: number;
          sum?: number;
          sale_id?: string | null;
        }>;
        feedback?: {
          ratings?: number;
          text?: string | null;
        } | null;
      }>
    >('GET', `/clients/${crmBuyerId}/history`, {
      query: {
        fields:
          'date,duration,professional,professional_name,paid,items(id,name,type,quantity,sum,sale_id),feedback',
      },
    });

    const items: CrmVisitHistoryItem[] = (raw ?? []).map((row) => {
      const booked =
        typeof row.duration === 'number' && row.duration > 0 ? row.duration : 0;
      return {
        id: row.id,
        date: row.date ?? '',
        durationMin: booked,
        bookedDurationMin: booked > 0 ? booked : undefined,
        professionalId: row.professional?.trim() || undefined,
        professionalName: row.professional_name || undefined,
        paid: row.paid,
        items: (row.items ?? []).map((it) => ({
          id: typeof it.id === 'string' && it.id.trim() ? it.id.trim() : undefined,
          name: it.name ?? '—',
          type: it.type ?? 'Service',
          quantity: it.quantity,
          sum: it.sum,
          saleId:
            typeof it.sale_id === 'string' && it.sale_id.trim()
              ? it.sale_id.trim()
              : undefined,
        })),
        feedbackRating:
          typeof row.feedback?.ratings === 'number' ? row.feedback.ratings : undefined,
        feedbackText: row.feedback?.text || undefined,
      };
    });

    // Newest first; API may return mixed order
    items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const sliced = items.slice(0, limit);
    await enrichHistoryWithSaleDurations(sliced);
    return sliced;
  },
};

export interface BeautyproDebugStep {
  stage: string;
  ok: boolean;
  method: string;
  /** URL with application_secret redacted. */
  url: string;
  httpStatus?: number;
  durationMs?: number;
  /** Parsed or raw response; tokens redacted. */
  response?: unknown;
  error?: string;
  note?: string;
}

export interface BeautyproConnectionTestResult {
  ok: boolean;
  status: 'granted' | 'pending' | 'refused' | 'error';
  message: string;
  server?: number;
  expiresAt?: string;
  database?: string;
  locationCount?: number;
  /** All active locations from GET /locations (for picking default UUID). */
  locations?: Array<{ id: string; name: string; address?: string }>;
  /** @deprecated use locations */
  locationsPreview?: Array<{ id: string; name: string; address?: string }>;
  /** Tokens/authStatus written to integration_beautypro (only when testing saved creds). */
  persisted?: boolean;
  /** Present when `debug: true` — for support / developer diagnosis. */
  debug?: {
    checkedAt: string;
    failedAtStage: string | null;
    applicationId: string;
    databaseCode: string;
    secretSource: 'override' | 'saved' | 'missing';
    matchesSavedCredentials: boolean;
    steps: BeautyproDebugStep[];
  };
}

function redactSecretInUrl(url: string): string {
  return url.replace(/([?&]application_secret=)[^&]*/gi, '$1***');
}

function maskTokenValue(value: string): string {
  const t = value.trim();
  if (!t) return '';
  if (t.length <= 10) return `*** (${t.length} chars)`;
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
}

function redactApiPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactApiPayload(item));
  }
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof v === 'string' &&
      /token|secret|password|authorization/i.test(k)
    ) {
      out[k] = maskTokenValue(v);
    } else {
      out[k] = redactApiPayload(v);
    }
  }
  return out;
}

function truncateJson(value: unknown, maxChars = 8000): unknown {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxChars) return value;
    return {
      _truncated: true,
      _originalChars: raw.length,
      preview: raw.slice(0, maxChars),
    };
  } catch {
    return String(value).slice(0, maxChars);
  }
}

/**
 * Probe BeautyPro auth + a light data call (GET /locations).
 * Same API host for test and live databases — only database_code differs.
 * Optional overrides allow testing form values before Save (masked secret → use DB).
 * Pass `debug: true` for per-stage request/response details (tokens redacted).
 */
export async function testBeautyproConnection(overrides?: {
  applicationId?: string;
  applicationSecret?: string;
  databaseCode?: string;
  debug?: boolean;
}): Promise<BeautyproConnectionTestResult> {
  const wantDebug = overrides?.debug === true;
  const steps: BeautyproDebugStep[] = [];
  const checkedAt = new Date().toISOString();

  const finish = (
    result: BeautyproConnectionTestResult,
    failedAtStage: string | null,
    meta: {
      applicationId: string;
      databaseCode: string;
      secretSource: 'override' | 'saved' | 'missing';
      matchesSavedCredentials: boolean;
    },
  ): BeautyproConnectionTestResult => {
    if (!wantDebug) return result;
    return {
      ...result,
      debug: {
        checkedAt,
        failedAtStage,
        applicationId: meta.applicationId,
        databaseCode: meta.databaseCode,
        secretSource: meta.secretSource,
        matchesSavedCredentials: meta.matchesSavedCredentials,
        steps,
      },
    };
  };

  const { beautypro } = await getIntegrationConfig({ fresh: true });
  const saved = {
    applicationId: beautypro.applicationId || config.BEAUTYPRO_APPLICATION_ID,
    applicationSecret:
      beautypro.applicationSecret || config.BEAUTYPRO_APPLICATION_SECRET,
    databaseCode: beautypro.databaseCode || config.BEAUTYPRO_DATABASE_CODE,
  };

  const applicationId =
    (overrides?.applicationId?.trim() || saved.applicationId).trim();
  const databaseCode =
    (overrides?.databaseCode?.trim() || saved.databaseCode).trim();
  const fromOverride = sanitizeIntegrationSecret(overrides?.applicationSecret);
  const applicationSecret = fromOverride || saved.applicationSecret;
  const secretSource: 'override' | 'saved' | 'missing' = fromOverride
    ? 'override'
    : saved.applicationSecret
      ? 'saved'
      : 'missing';

  const metaBase = {
    applicationId: applicationId || '(empty)',
    databaseCode: databaseCode || '(empty)',
    secretSource,
    matchesSavedCredentials: false,
  };

  if (!applicationId || !applicationSecret || !databaseCode) {
    steps.push({
      stage: 'resolve_credentials',
      ok: false,
      method: 'LOCAL',
      url: 'integration_beautypro',
      error: 'missing applicationId / applicationSecret / databaseCode',
      response: {
        hasApplicationId: Boolean(applicationId),
        hasApplicationSecret: Boolean(applicationSecret),
        hasDatabaseCode: Boolean(databaseCode),
        secretSource,
      },
    });
    return finish(
      {
        ok: false,
        status: 'error',
        message:
          'Потрібні Application ID, Application Secret і Database code (спочатку збережіть або введіть у формі)',
      },
      'resolve_credentials',
      metaBase,
    );
  }

  const matchesSaved =
    Boolean(saved.applicationId && saved.applicationSecret && saved.databaseCode) &&
    applicationId === saved.applicationId &&
    databaseCode === saved.databaseCode &&
    applicationSecret === saved.applicationSecret;
  metaBase.matchesSavedCredentials = matchesSaved;

  steps.push({
    stage: 'resolve_credentials',
    ok: true,
    method: 'LOCAL',
    url: 'integration_beautypro',
    response: {
      applicationId,
      databaseCode,
      secretSource,
      matchesSavedCredentials: matchesSaved,
      savedAuthStatus: beautypro.authStatus || '',
      savedApiServer: beautypro.apiServer || null,
      savedTokenExpiresAt: beautypro.tokenExpiresAt || null,
    },
  });

  const url = new URL(`${AUTH_HOST}/auth/database`);
  url.searchParams.set('application_id', applicationId);
  url.searchParams.set('application_secret', applicationSecret);
  url.searchParams.set('database_code', databaseCode);
  const authUrlSafe = redactSecretInUrl(url.toString());

  let authBody: Record<string, unknown>;
  let authHttpStatus = 0;
  try {
    const t0 = Date.now();
    const res = await fetch(url.toString(), { method: 'GET' });
    authHttpStatus = res.status;
    const durationMs = Date.now() - t0;
    const rawText = await res.text();
    try {
      authBody = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      authBody = { _nonJson: rawText.slice(0, 2000) };
    }
    steps.push({
      stage: 'auth_database',
      ok: res.ok,
      method: 'GET',
      url: authUrlSafe,
      httpStatus: res.status,
      durationMs,
      response: truncateJson(redactApiPayload(authBody)),
      note: 'GET https://api.aihelps.com/v1/auth/database — auth always on server 1',
    });
    if (!res.ok) {
      return finish(
        {
          ok: false,
          status: 'error',
          message: `Auth HTTP ${res.status}: ${JSON.stringify(authBody).slice(0, 280)}`,
          persisted: false,
        },
        'auth_database',
        metaBase,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({
      stage: 'auth_database',
      ok: false,
      method: 'GET',
      url: authUrlSafe,
      httpStatus: authHttpStatus || undefined,
      error: message,
    });
    return finish(
      {
        ok: false,
        status: 'error',
        message: `Не вдалося звернутись до api.aihelps.com: ${message.slice(0, 200)}`,
        persisted: false,
      },
      'auth_database',
      metaBase,
    );
  }

  if (typeof authBody.status === 'string' && !authBody.access_token) {
    const status = authBody.status === 'refused' ? 'refused' : 'pending';
    if (matchesSaved) {
      await persistTokens({ authStatus: status });
    }
    steps.push({
      stage: 'grant_access',
      ok: false,
      method: 'N/A',
      url: 'BeautyPro → Settings → Marketplace → Grant access',
      response: { authStatus: status, raw: redactApiPayload(authBody) },
      note:
        status === 'pending'
          ? 'Credentials OK; access request created. Owner must Grant access, then re-test.'
          : 'Owner refused Marketplace access for this application.',
    });
    return finish(
      {
        ok: false,
        status,
        message:
          status === 'refused'
            ? 'Доступ відхилено в Marketplace'
            : 'Очікує Grant access: BeautyPro → Settings → Marketplace → Grant access (потім натисніть перевірку знову)',
        persisted: matchesSaved,
      },
      'grant_access',
      metaBase,
    );
  }

  const accessToken =
    typeof authBody.access_token === 'string' ? authBody.access_token : '';
  if (!accessToken) {
    steps.push({
      stage: 'auth_database',
      ok: false,
      method: 'GET',
      url: authUrlSafe,
      response: truncateJson(redactApiPayload(authBody)),
      error: 'no access_token and no pending/refused status',
    });
    return finish(
      {
        ok: false,
        status: 'error',
        message: 'Відповідь auth без access_token і без status pending/refused',
        persisted: false,
      },
      'auth_database',
      metaBase,
    );
  }

  const apiServer = typeof authBody.server === 'number' ? authBody.server : 1;
  const expiresAt =
    typeof authBody.expires_at === 'string'
      ? authBody.expires_at
      : new Date(Date.now() + 23 * 3600_000).toISOString();
  const refreshToken =
    typeof authBody.refresh_token === 'string' ? authBody.refresh_token : '';
  const database =
    typeof authBody.database === 'string' ? authBody.database : databaseCode;

  steps.push({
    stage: 'token_issued',
    ok: true,
    method: 'GET',
    url: authUrlSafe,
    response: {
      server: apiServer,
      database,
      expires_at: expiresAt,
      has_refresh_token: Boolean(refreshToken),
      scope: authBody.scope ?? null,
      location: authBody.location ?? null,
      access_token: maskTokenValue(accessToken),
    },
    note: `Data API host will be ${apiHostForServer(apiServer)}`,
  });

  const tokens: TokenState = {
    accessToken,
    refreshToken,
    expiresAt,
    apiServer,
    authStatus: 'granted',
  };

  let locationCount = 0;
  let locations: Array<{ id: string; name: string; address?: string }> = [];
  const base = apiHostForServer(apiServer);
  const locUrl = new URL(`${base}/locations`);
  locUrl.searchParams.set('fields', 'name,city,street,active');

  try {
    const t0 = Date.now();
    const locRes = await fetch(locUrl.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const durationMs = Date.now() - t0;
    const locText = await locRes.text();
    let locParsed: unknown = locText;
    try {
      locParsed = locText ? JSON.parse(locText) : [];
    } catch {
      locParsed = { _nonJson: locText.slice(0, 2000) };
    }

    if (!locRes.ok) {
      steps.push({
        stage: 'locations',
        ok: false,
        method: 'GET',
        url: locUrl.toString(),
        httpStatus: locRes.status,
        durationMs,
        response: truncateJson(redactApiPayload(locParsed)),
        note: 'Auth succeeded; data call failed (token/server/scope issue?)',
      });
      if (matchesSaved) await persistTokens(tokens);
      return finish(
        {
          ok: false,
          status: 'error',
          message: `Auth OK (server ${apiServer}), але GET /locations → HTTP ${locRes.status}: ${locText.slice(0, 200)}`,
          server: apiServer,
          expiresAt,
          database,
          persisted: matchesSaved,
        },
        'locations',
        metaBase,
      );
    }
    const rows = (Array.isArray(locParsed) ? locParsed : []) as RawLocation[];
    const active = (rows ?? []).filter((l) => l.active !== false);
    locationCount = active.length;
    locations = active.map((l) => ({
      id: l.id,
      name: l.name,
      address: [l.city, l.street].filter(Boolean).join(', ') || undefined,
    }));
    steps.push({
      stage: 'locations',
      ok: true,
      method: 'GET',
      url: locUrl.toString(),
      httpStatus: locRes.status,
      durationMs,
      response: truncateJson({
        activeCount: locationCount,
        totalReturned: rows.length,
        locations,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({
      stage: 'locations',
      ok: false,
      method: 'GET',
      url: locUrl.toString(),
      error: message,
    });
    if (matchesSaved) await persistTokens(tokens);
    return finish(
      {
        ok: false,
        status: 'error',
        message: `Auth OK, але читання локацій зірвалось: ${message.slice(0, 200)}`,
        server: apiServer,
        expiresAt,
        database,
        persisted: matchesSaved,
      },
      'locations',
      metaBase,
    );
  }

  if (matchesSaved) {
    await persistTokens(tokens);
  }
  steps.push({
    stage: 'persist_tokens',
    ok: true,
    method: 'LOCAL',
    url: 'settings.integration_beautypro',
    response: {
      persisted: matchesSaved,
      authStatus: 'granted',
      apiServer,
      expiresAt,
    },
    note: matchesSaved
      ? 'Tokens saved to tenant settings'
      : 'Not persisted — form credentials differ from saved; Save integrations first',
  });

  const saveHint = matchesSaved
    ? ''
    : ' Credentials ще не збережені в інтеграції — натисніть «Зберегти», потім перевірте знову, щоб токени залишились на сервері.';

  return finish(
    {
      ok: true,
      status: 'granted',
      message: `Підключення OK · база ${database} · server ${apiServer} · локацій: ${locationCount}.${saveHint}`,
      server: apiServer,
      expiresAt,
      database,
      locationCount,
      locations,
      locationsPreview: locations,
      persisted: matchesSaved,
    },
    null,
    metaBase,
  );
}

export type BeautyproProbeDataset = 'locations' | 'services' | 'employees';

export interface BeautyproProbeLocation {
  id: string;
  name: string;
  address?: string;
}

export interface BeautyproProbeService {
  id: string;
  name: string;
  durationMin: number;
  categoryName?: string;
  price: number;
  locationPrices: Array<{ locationId: string; price: number }>;
}

export interface BeautyproProbeEmployee {
  id: string;
  name: string;
  public?: boolean;
  archive?: boolean;
}

export interface BeautyproProbeResult {
  ok: boolean;
  status: 'granted' | 'pending' | 'refused' | 'error';
  message: string;
  server?: number;
  locations?: BeautyproProbeLocation[];
  services?: BeautyproProbeService[];
  employees?: BeautyproProbeEmployee[];
  debug?: {
    checkedAt: string;
    failedAtStage: string | null;
    datasets: BeautyproProbeDataset[];
    steps: BeautyproDebugStep[];
  };
}

/**
 * After auth, pull locations / services(+prices) / professionals for admin verify.
 */
export async function probeBeautyproDatasets(opts: {
  datasets: BeautyproProbeDataset[];
  applicationId?: string;
  applicationSecret?: string;
  databaseCode?: string;
  debug?: boolean;
}): Promise<BeautyproProbeResult> {
  const wantDebug = opts.debug === true;
  const datasets = [...new Set(opts.datasets)].filter(
    (d): d is BeautyproProbeDataset =>
      d === 'locations' || d === 'services' || d === 'employees',
  );
  const checkedAt = new Date().toISOString();
  const steps: BeautyproDebugStep[] = [];

  if (datasets.length === 0) {
    return {
      ok: false,
      status: 'error',
      message: 'Вкажіть datasets: locations | services | employees',
    };
  }

  // Reuse connection test for auth + grant gate (also refreshes tokens when saved).
  const auth = await testBeautyproConnection({
    applicationId: opts.applicationId,
    applicationSecret: opts.applicationSecret,
    databaseCode: opts.databaseCode,
    debug: wantDebug,
  });

  if (wantDebug && auth.debug?.steps) {
    steps.push(...auth.debug.steps);
  }

  if (!auth.ok) {
    return {
      ok: false,
      status: auth.status,
      message: auth.message,
      debug: wantDebug
        ? {
            checkedAt,
            failedAtStage: auth.debug?.failedAtStage ?? 'grant_access',
            datasets,
            steps,
          }
        : undefined,
    };
  }

  const result: BeautyproProbeResult = {
    ok: true,
    status: 'granted',
    message: '',
    server: auth.server,
  };

  try {
    if (datasets.includes('locations')) {
      const t0 = Date.now();
      const rows = await bpFetch<RawLocation[]>('GET', '/locations', {
        query: { fields: 'name,city,street,active' },
      });
      const active = (rows ?? []).filter((l) => l.active !== false);
      result.locations = active.map((l) => ({
        id: l.id,
        name: l.name,
        address: [l.city, l.street].filter(Boolean).join(', ') || undefined,
      }));
      steps.push({
        stage: 'probe_locations',
        ok: true,
        method: 'GET',
        url: '/locations',
        durationMs: Date.now() - t0,
        response: truncateJson({
          totalCount: result.locations.length,
          sample: result.locations.slice(0, 100),
        }),
      });
    }

    if (datasets.includes('services')) {
      const t0 = Date.now();
      const [raw, categories, positions] = await Promise.all([
        bpFetch<RawService[]>('GET', '/services', {
          query: {
            fields:
              'name,description,duration,category,public,location_prices,archive,price_currency',
            public: true,
            archive: false,
          },
        }),
        fetchCategoryMap(),
        fetchPositionMap(),
      ]);
      const mapped = (raw ?? [])
        .filter((s) => s.archive !== true)
        .map((s) => {
          const item = mapService(s, categories, positions);
          return {
            id: item.id,
            name: item.name,
            durationMin: item.durationMin,
            categoryName: item.categoryName,
            price: item.price,
            locationPrices: (item.branchPrices ?? []).map((bp) => ({
              locationId: bp.branchId,
              price: bp.price,
            })),
          } satisfies BeautyproProbeService;
        });
      result.services = mapped;
      steps.push({
        stage: 'probe_services',
        ok: true,
        method: 'GET',
        url: '/services',
        durationMs: Date.now() - t0,
        response: truncateJson({
          totalCount: mapped.length,
          sample: mapped.slice(0, 100),
        }),
      });
    }

    if (datasets.includes('employees')) {
      const t0 = Date.now();
      const rows = await bpFetch<RawEmployee[]>('GET', '/employees', {
        query: {
          fields: 'name,archive,public,roles',
          role: 'professional',
          archive: false,
        },
      });
      result.employees = (rows ?? [])
        .filter((e) => e.archive !== true)
        .map((e) => ({
          id: e.id,
          name: e.name,
          public: e.public,
          archive: e.archive,
        }));
      steps.push({
        stage: 'probe_employees',
        ok: true,
        method: 'GET',
        url: '/employees?role=professional',
        durationMs: Date.now() - t0,
        response: truncateJson({
          totalCount: result.employees.length,
          sample: result.employees.slice(0, 100),
        }),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({
      stage: 'probe_fetch',
      ok: false,
      method: 'GET',
      url: 'beautypro datasets',
      error: message,
    });
    return {
      ok: false,
      status: 'error',
      message: `Auth OK, але probe зірвався: ${message.slice(0, 280)}`,
      server: auth.server,
      locations: result.locations,
      services: result.services,
      employees: result.employees,
      debug: wantDebug
        ? { checkedAt, failedAtStage: 'probe_fetch', datasets, steps }
        : undefined,
    };
  }

  const parts: string[] = [];
  if (result.locations) parts.push(`локацій ${result.locations.length}`);
  if (result.services) parts.push(`послуг ${result.services.length}`);
  if (result.employees) parts.push(`майстрів ${result.employees.length}`);
  result.message = `Probe OK · ${parts.join(' · ') || 'немає даних'}`;

  if (wantDebug) {
    result.debug = {
      checkedAt,
      failedAtStage: null,
      datasets,
      steps,
    };
  }

  return result;
}
