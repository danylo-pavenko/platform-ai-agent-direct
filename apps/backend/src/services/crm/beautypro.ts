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
  CrmSlot,
  CrmSlotQuery,
  CrmVisitHistoryItem,
  OfferSearchParams,
  ProductSearchParams,
} from './types.js';

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

type FreeTimeResponse = Record<string, Record<string, string[]>>;

function digitsPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Agent dates are DD.MM.YYYY (CleverBOX style) or ISO YYYY-MM-DD. */
function parseAgentDate(date: string): { y: number; m: number; d: number } | null {
  const trimmed = date.trim();
  const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (dmy) {
    return { d: Number(dmy[1]), m: Number(dmy[2]), y: Number(dmy[3]) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) {
    return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  }
  return null;
}

function toIsoDate(parts: { y: number; m: number; d: number }): string {
  return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
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
  const basePrice =
    typeof raw.no_professional_price === 'number' && raw.no_professional_price > 0
      ? raw.no_professional_price
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
        fields:
          'name,description,duration,category,public,location_prices,no_professional_price,archive',
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

function invertFreeTime(
  free: FreeTimeResponse,
): { slots: Record<string, CrmSlot[]>; masterIds: Set<string> } {
  const slots: Record<string, CrmSlot[]> = {};
  const masterIds = new Set<string>();

  // API: { professionalId: { "YYYY-MM-DD": ["10:00", ...] } }
  // We need: { date: [{ time, masterIds }] }
  const byDateTime = new Map<string, Map<string, string[]>>();

  for (const [professionalId, days] of Object.entries(free ?? {})) {
    masterIds.add(professionalId);
    for (const [day, times] of Object.entries(days ?? {})) {
      if (!byDateTime.has(day)) byDateTime.set(day, new Map());
      const dayMap = byDateTime.get(day)!;
      for (const time of times ?? []) {
        const list = dayMap.get(time) ?? [];
        list.push(professionalId);
        dayMap.set(time, list);
      }
    }
  }

  for (const [day, timeMap] of byDateTime) {
    const daySlots: CrmSlot[] = [];
    for (const [time, masters] of [...timeMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      daySlots.push({ date: day, time, masterIds: masters });
    }
    slots[day] = daySlots;
  }

  return { slots, masterIds };
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
    const parts = parseAgentDate(query.date);
    if (!parts) {
      throw new Error(`BeautyPro: invalid date "${query.date}" (use DD.MM.YYYY or YYYY-MM-DD)`);
    }

    let from: Date;
    let to: Date;
    if (query.fullMonth) {
      from = new Date(Date.UTC(parts.y, parts.m - 1, 1, 0, 0, 0));
      to = new Date(Date.UTC(parts.y, parts.m, 0, 23, 59, 59));
    } else {
      from = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0));
      to = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 23, 59, 59));
    }

    const duration = Math.max(
      ...query.services.map((s) => s.durationMin || 60),
      15,
    );

    const free = await bpFetch<FreeTimeResponse>('GET', '/employees/free_time', {
      query: {
        from: from.toISOString(),
        to: to.toISOString(),
        duration,
        step: 'auto',
        location: query.branchId,
        services: query.services.map((s) => s.id).join(','),
        public_employees: true,
        add_now_time: 20,
        nearest_day_only: !query.fullMonth,
      },
    });

    const { slots, masterIds } = invertFreeTime(free);

    let masters: Array<{ id: string; name: string }> = [];
    if (masterIds.size > 0) {
      try {
        const employees = await bpFetch<RawEmployee[]>('GET', '/employees', {
          query: {
            fields: 'name,archive,public,roles',
            location: query.branchId,
            role: 'professional',
            public: true,
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

    return { slots, masters };
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
