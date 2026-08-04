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
import {
  assertFreeTimePayload,
  buildFreeTimeQueryParams,
  invertFreeTime,
  parseAgentDate,
  toIsoDate,
  type FreeTimeResponse,
} from './beautypro-free-time.js';

const log = pino({ name: 'crm:beautypro' });

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
    price?: number | null;
    staff_price?: number | null;
  }>;
  no_professional_price?: number | null;
}

interface RawCategory {
  id: string;
  name: string;
}

interface RawEmployee {
  id: string;
  name: string;
  archive?: boolean;
  public?: boolean;
  roles?: string | string[];
}

interface RawClient {
  id: string;
  name?: string;
  firstname?: string;
  lastname?: string;
  phone?: string[] | string | null;
  email?: string[] | string | null;
  comments?: string | null;
}

function digitsPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function normalizeStartTime(time: string): string {
  const t = time.trim();
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(t)) return t;
  if (/^\d{1,2}:\d{2}$/.test(t)) return `${t}:00`;
  return t;
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

function mapService(raw: RawService, categories: Map<string, string>): CrmServiceItem {
  const prices = raw.location_prices ?? [];
  const priceFromLocations = prices
    .map((p) => (typeof p.price === 'number' ? p.price : 0))
    .filter((p) => p > 0);
  // Optional field — some API scopes omit it; do not request it in `fields`
  // (live GET /services returns 400 Unknown parameter 'no_professional_price').
  const noProPrice =
    typeof raw.no_professional_price === 'number' && raw.no_professional_price > 0
      ? raw.no_professional_price
      : 0;
  const basePrice =
    noProPrice > 0
      ? noProPrice
      : priceFromLocations.length > 0
        ? Math.min(...priceFromLocations)
        : 0;

  return {
    id: raw.id,
    name: raw.name,
    price: basePrice,
    durationMin: raw.duration ?? 60,
    categoryName: raw.category ? categories.get(raw.category) : undefined,
    branchPrices: prices.map((p) => ({
      branchId: p.location,
      branchName: p.location,
      price: typeof p.price === 'number' ? p.price : 0,
    })),
  };
}

async function fetchAllServices(): Promise<CrmServiceItem[]> {
  const [raw, categories] = await Promise.all([
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
  ]);

  return (raw ?? [])
    .filter((s) => s.archive !== true)
    .map((s) => mapService(s, categories));
}

async function fetchFreeTimeWithFallbacks(query: CrmSlotQuery): Promise<FreeTimeResponse> {
  const attempts: Array<{
    label: string;
    nearestDayOnly: boolean;
    publicEmployees?: boolean;
    includeServices: boolean;
  }> = [
    // Specific calendar day: ask for ALL slots in from..to (not "nearest day only").
    {
      label: 'day_all_public',
      nearestDayOnly: false,
      publicEmployees: true,
      includeServices: true,
    },
    // Some salons leave public=false on masters that still take bookings.
    {
      label: 'day_all_employees',
      nearestDayOnly: false,
      publicEmployees: undefined,
      includeServices: true,
    },
    // Service↔location pairing can 400; duration-only still returns usable windows.
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
        },
        'BeautyPro free_time attempt failed',
      );
    }
  }

  throw new Error(
    `BeautyPro free_time failed after ${attempts.length} attempts: ${errors.join(' | ')}`.slice(
      0,
      600,
    ),
  );
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
        fields: 'name,city,street,phone,timezone,active',
        active: true,
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
    const rows = await bpFetch<RawEmployee[]>('GET', '/employees', {
      query: {
        fields: 'name,archive,public,roles',
        role: 'professional',
        archive: false,
      },
    });
    return (rows ?? [])
      .filter((e) => e.archive !== true)
      .map((e) => ({
        id: e.id,
        name: e.name,
        public: e.public,
      }));
  },

  async searchServices(query: string, limit = 8): Promise<CrmServiceItem[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = await fetchAllServices();
    return all
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.categoryName?.toLowerCase().includes(q),
      )
      .slice(0, limit);
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
    if (!match.phone) return null;

    const phone = match.phone.trim();
    const rows = await bpFetch<RawClient[]>('GET', '/clients', {
      query: {
        fields: 'name,firstname,lastname,phone,email,comments',
        phone,
        archive: false,
      },
    });

    const hit = (rows ?? [])[0];
    if (!hit?.id) {
      // Retry with digits-only if formatted phone returned nothing
      const digits = digitsPhone(phone);
      if (digits && digits !== phone) {
        const rows2 = await bpFetch<RawClient[]>('GET', '/clients', {
          query: {
            fields: 'name,firstname,lastname,phone',
            phone: digits,
            archive: false,
          },
        });
        const hit2 = (rows2 ?? [])[0];
        return hit2?.id ? { crmBuyerId: hit2.id } : null;
      }
      return null;
    }
    return { crmBuyerId: hit.id };
  },

  async upsertClient(crmBuyerId: string | null, input: CrmClientInput) {
    const { firstname, lastname } = splitClientName(input.fullName);
    const noteParts = [
      input.note,
      input.instagramUsername ? `IG: @${input.instagramUsername.replace(/^@/, '')}` : null,
    ].filter(Boolean);
    const comments = noteParts.join('\n') || undefined;

    if (crmBuyerId) {
      await bpFetch('PUT', `/clients/${crmBuyerId}`, {
        body: {
          firstname,
          lastname,
          ...(input.phone ? { phone: [input.phone] } : {}),
          ...(input.email ? { email: [input.email] } : {}),
          ...(comments ? { comments } : {}),
        },
      });
      return { crmBuyerId };
    }

    const created = await bpFetch<{ id: string }>('POST', '/clients', {
      query: { fields: 'id' },
      body: {
        firstname,
        lastname,
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.email ? { email: input.email } : {}),
        ...(comments ? { comments } : {}),
      },
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
          note: input.comment,
        });
        clientId = created.crmBuyerId;
      }
    }

    let professional = input.services[0]?.masterId;
    if (!professional) {
      const candidates = input.services[0]
        ? (
            await bpFetch<RawEmployee[]>('GET', '/employees', {
              query: {
                fields: 'name',
                location: input.branchId,
                service: input.services.map((s) => s.id).join(','),
                role: 'professional',
                public: true,
                archive: false,
              },
            })
          )?.map((e) => e.id) ?? []
        : [];

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

    const start = normalizeStartTime(input.services[0]?.startTime ?? '10:00');
    const body = {
      date: isoDate,
      location: input.branchId,
      client: clientId,
      state: 'planned',
      comments: input.comment,
      services: input.services.map((s, idx) => ({
        service: s.id,
        professional: s.masterId || professional,
        start: idx === 0 ? start : normalizeStartTime(s.startTime),
        duration: s.durationMin || 60,
      })),
    };

    const created = await bpFetch<{ id: string; smsError?: unknown }>(
      'POST',
      '/appointments',
      {
        query: {
          fields: 'id,date,location,client,services,comments',
        },
        body,
      },
    );

    if (!created?.id) {
      throw new Error('BeautyPro appointment create returned no id');
    }

    if (created.smsError) {
      log.warn({ smsError: created.smsError, id: created.id }, 'BeautyPro SMS warning');
    }

    log.info({ appointmentId: created.id }, 'BeautyPro booking created');
    return { crmRecordId: created.id, crmBuyerId: clientId };
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
          name?: string;
          type?: string;
          quantity?: number;
          sum?: number;
        }>;
        feedback?: {
          ratings?: number;
          text?: string | null;
        } | null;
      }>
    >('GET', `/clients/${crmBuyerId}/history`, {
      query: {
        fields:
          'date,duration,professional,professional_name,paid,items(id,name,type,quantity,sum),feedback',
      },
    });

    const items: CrmVisitHistoryItem[] = (raw ?? []).map((row) => ({
      id: row.id,
      date: row.date ?? '',
      durationMin: typeof row.duration === 'number' ? row.duration : 0,
      professionalId: row.professional?.trim() || undefined,
      professionalName: row.professional_name || undefined,
      paid: row.paid,
      items: (row.items ?? []).map((it) => ({
        name: it.name ?? '—',
        type: it.type ?? 'Service',
        quantity: it.quantity,
        sum: it.sum,
      })),
      feedbackRating:
        typeof row.feedback?.ratings === 'number' ? row.feedback.ratings : undefined,
      feedbackText: row.feedback?.text || undefined,
    }));

    // Newest first; API may return mixed order
    items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return items.slice(0, limit);
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
  locUrl.searchParams.set('active', 'true');

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
        query: { fields: 'name,city,street,active', active: true },
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
      const [raw, categories] = await Promise.all([
        bpFetch<RawService[]>('GET', '/services', {
          query: {
            fields:
              'name,description,duration,category,public,location_prices,archive,price_currency',
            public: true,
            archive: false,
          },
        }),
        fetchCategoryMap(),
      ]);
      const mapped = (raw ?? [])
        .filter((s) => s.archive !== true)
        .map((s) => {
          const item = mapService(s, categories);
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
