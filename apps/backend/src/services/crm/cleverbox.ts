/**
 * CleverBOX CRM adapter — salon booking, services, filials.
 * API docs: https://cbox.mobi/doc/rest/
 */

import pino from 'pino';
import { getIntegrationConfig } from '../../lib/integration-config.js';
import { config } from '../../config.js';
import type {
  CrmAdapter,
  CrmBookingInput,
  CrmBranch,
  CrmCategory,
  CrmOffer,
  CrmProduct,
  CrmServiceItem,
  CrmSlotQuery,
  OfferSearchParams,
  ProductSearchParams,
} from './types.js';

const log = pino({ name: 'crm:cleverbox' });

const V2_BASE = 'https://cbox.mobi/api/v2/rest';
const V3_BASE = 'https://cbox.mobi/api/v3/rest';

interface CboxOk<T> {
  ok: boolean;
  data?: T;
  offset?: number;
  limit?: number;
}

interface RawFilial {
  id: number;
  title: string;
  is_hidden?: number;
}

interface RawServiceItem {
  id: number;
  name: string;
  price?: number;
  time?: number;
  category_name?: string;
  prices?: Array<{ salon_id: string; salon_name?: string; price: string | number }>;
}

interface RawSlotDay {
  on: boolean;
  time: string;
  masters: string[];
}

interface RawSlotsResponse {
  ok: boolean;
  slots?: Record<string, RawSlotDay[]>;
  masters?: Array<{ id: string; name: string }>;
}

interface RawBookingResponse {
  ok: boolean;
  record_id?: number;
  comment?: string;
  invoice?: { link?: string };
}

async function getToken(): Promise<string> {
  const { cleverbox } = await getIntegrationConfig();
  const token = cleverbox.apiToken || config.CLEVERBOX_API_TOKEN;
  if (!token) throw new Error('CleverBOX API token not configured');
  return token;
}

async function cboxJson<T>(
  version: 'v2' | 'v3',
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const token = await getToken();
  const base = version === 'v3' ? V3_BASE : V2_BASE;
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CleverBOX ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return (await res.json()) as T;
}

function mapService(raw: RawServiceItem): CrmServiceItem {
  return {
    id: String(raw.id),
    name: raw.name,
    price: typeof raw.price === 'number' ? raw.price : Number(raw.price) || 0,
    durationMin: raw.time ?? 60,
    categoryName: raw.category_name,
    branchPrices: raw.prices?.map((p) => ({
      branchId: String(p.salon_id),
      branchName: p.salon_name ?? String(p.salon_id),
      price: typeof p.price === 'number' ? p.price : Number(p.price) || 0,
    })),
  };
}

function toCboxNumericId(id: string): number {
  const n = Number(id);
  if (!Number.isFinite(n)) {
    throw new Error(`CleverBOX expects numeric id, got "${id}"`);
  }
  return n;
}

async function fetchAllServices(): Promise<CrmServiceItem[]> {
  const items: CrmServiceItem[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const res = await cboxJson<CboxOk<RawServiceItem[]>>('v2', '/services', { offset });
    const batch = res.data ?? [];
    items.push(...batch.map(mapService));
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 10_000) break;
  }

  return items;
}

export const cleverboxAdapter: CrmAdapter = {
  name: 'cleverbox',
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
    const res = await cboxJson<CboxOk<RawFilial[]>>('v2', '/filials', {});
    return (res.data ?? [])
      .filter((f) => f.is_hidden !== 1)
      .map((f) => ({
        id: String(f.id),
        name: f.title,
        metadata: { is_hidden: f.is_hidden },
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
      .filter((s) => s.name.toLowerCase().includes(q) || s.categoryName?.toLowerCase().includes(q))
      .slice(0, limit);
  },

  async getAvailableSlots(query: CrmSlotQuery) {
    const res = await cboxJson<RawSlotsResponse>('v2', '/slots/get', {
      date: query.date,
      salon_id: query.branchId,
      all: query.fullMonth ?? false,
      services: query.services.map((s) => ({
        id: String(s.id),
        long: s.durationMin,
      })),
    });

    const slots: Record<string, Array<{ date: string; time: string; masterIds: string[] }>> = {};
    for (const [day, rows] of Object.entries(res.slots ?? {})) {
      slots[day] = rows
        .filter((r) => r.on)
        .map((r) => ({
          date: day,
          time: r.time,
          masterIds: r.masters ?? [],
        }));
    }

    return {
      slots,
      masters: res.masters ?? [],
    };
  },

  async createBooking(input: CrmBookingInput) {
    const res = await cboxJson<RawBookingResponse>('v3', '/slots/save', {
      date: input.date,
      salon_id: toCboxNumericId(input.branchId),
      client_id: input.clientId ? toCboxNumericId(input.clientId) : 0,
      name: input.clientName,
      phone: input.phone.replace(/\D/g, ''),
      comment: input.comment,
      services: input.services.map((s) => ({
        id: toCboxNumericId(s.id),
        long: s.durationMin,
        master_id: s.masterId ? toCboxNumericId(s.masterId) : undefined,
        time: s.startTime,
      })),
    });

    if (!res.ok || !res.record_id) {
      throw new Error(res.comment ?? 'CleverBOX booking failed');
    }

    log.info({ recordId: res.record_id }, 'CleverBOX booking created');
    return {
      crmRecordId: String(res.record_id),
      comment: res.comment,
      paymentLink: res.invoice?.link,
    };
  },

  async cancelBooking(recordId: string, reason?: 'move' | 'cancel') {
    await cboxJson('v3', '/slots/cancel', {
      record_id: toCboxNumericId(recordId),
      ...(reason === 'move' ? { status: 'move' } : {}),
    });
  },
};
