/**
 * KeyCRM implementation of CrmAdapter.
 *
 * All HTTP to openapi.keycrm.app lives here so other consumers never
 * import vendor-specific code. Includes:
 *   - paginated reads for sync-worker (fetchCategories / fetchProducts / fetchOffers)
 *   - filtered runtime reads for product-search (searchProducts / searchOffers)
 *   - write stubs (Phase 2 — populated in a follow-up commit)
 */

import pino from 'pino';
import { config } from '../../config.js';
import { getIntegrationConfig } from '../../lib/integration-config.js';
import type {
  CrmAdapter,
  CrmCategory,
  CrmProduct,
  CrmOffer,
  CrmClientMatch,
  CrmClientInput,
  CrmOrderInput,
  CrmLeadInput,
  CrmCustomFieldDef,
  ProductSearchParams,
  OfferSearchParams,
} from './types.js';

const log = pino({ name: 'crm:keycrm' });

const BASE_URL = 'https://openapi.keycrm.app/v1';
const MAX_RETRIES = 3;
const PACING_MS = 150;
const PER_PAGE = 50;
const RUNTIME_TIMEOUT_MS = 8_000;

// ── Raw KeyCRM response shapes (snake_case → camelCase mapped below) ───────

interface RawCategory {
  id: number;
  name: string;
  parent_id: number | null;
}

interface RawProduct {
  id: number;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  attachments_data: string[] | null;
  quantity: number;
  currency_code: string;
  min_price: number | null;
  max_price: number | null;
  has_offers: boolean;
  is_archived: boolean;
  category_id: number | null;
  created_at: string;
  updated_at: string;
}

interface RawOffer {
  id: number;
  product_id: number;
  sku: string | null;
  barcode: string | null;
  thumbnail_url: string | null;
  price: number;
  purchased_price: number;
  quantity: number;
  in_reserve: number;
  properties: Array<{ name: string; value: string }> | null;
  is_archived: boolean;
  product?: RawProduct;
}

interface PaginatedResponse<T> {
  total: number;
  current_page: number;
  per_page: number;
  next_page_url: string | null;
  data: T[];
}

interface RawBuyer {
  id: number;
  full_name: string;
  email: string[] | null;
  phone: string[] | null;
  note: string | null;
}

interface RawCustomField {
  id: number;
  uuid: string;
  name: string;
  model: string;  // "order" | "lead" | "client" | "crm_product"
  type: string;   // "text" | "textarea" | "select" | "switcher" | "number" | "float" | "date" | "datetime" | "link"
  is_multiple?: boolean;
  required?: boolean;
  options?: Array<{ id: number; value: string }>;
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapCategory(r: RawCategory): CrmCategory {
  return { id: r.id, name: r.name, parentId: r.parent_id };
}

function mapProduct(r: RawProduct): CrmProduct {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    thumbnailUrl: r.thumbnail_url,
    attachmentsData: r.attachments_data ?? [],
    quantity: r.quantity,
    currencyCode: r.currency_code,
    minPrice: r.min_price,
    maxPrice: r.max_price,
    hasOffers: r.has_offers,
    isArchived: r.is_archived,
    categoryId: r.category_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapOffer(r: RawOffer): CrmOffer {
  return {
    id: r.id,
    productId: r.product_id,
    sku: r.sku,
    barcode: r.barcode,
    thumbnailUrl: r.thumbnail_url,
    price: r.price,
    purchasedPrice: r.purchased_price,
    quantity: r.quantity,
    inReserve: r.in_reserve,
    properties: r.properties ?? [],
    isArchived: r.is_archived,
    product: r.product ? mapProduct(r.product) : undefined,
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keycrmGet<T>(
  path: string,
  params?: Record<string, string>,
  opts: { retry?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const retry = opts.retry ?? true;
  const timeoutMs = opts.timeoutMs ?? RUNTIME_TIMEOUT_MS;
  const maxAttempts = retry ? MAX_RETRIES : 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const backoff = PACING_MS * Math.pow(2, attempt - 1);
      log.warn({ attempt, backoff }, 'Retrying after backoff');
      await sleep(backoff);
    } else if (retry) {
      await sleep(PACING_MS);
    }

    const { keycrm } = await getIntegrationConfig();
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${keycrm.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const status = response.status;
    const body = await response.text();

    if (retry && (status === 429 || status >= 500)) {
      lastError = new Error(`KeyCRM ${status} on ${path}: ${body.slice(0, 200)}`);
      log.warn({ status, path, attempt }, 'Retryable error from KeyCRM');
      continue;
    }

    throw new Error(`KeyCRM ${status} on ${path}: ${body.slice(0, 500)}`);
  }

  throw lastError ?? new Error(`KeyCRM request failed after ${maxAttempts} retries`);
}

/**
 * POST/PUT helper with JSON body. Writes are *not* retried by default —
 * KeyCRM can return a 2xx after a 5xx on its side, and replaying a write
 * risks creating duplicate buyers/orders. Caller decides idempotency.
 */
async function keycrmJson<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const timeoutMs = opts.timeoutMs ?? RUNTIME_TIMEOUT_MS;

  const { keycrm } = await getIntegrationConfig();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${keycrm.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.ok) {
    return (await response.json()) as T;
  }

  const status = response.status;
  const text = await response.text();
  throw new Error(`KeyCRM ${method} ${status} on ${path}: ${text.slice(0, 500)}`);
}

/**
 * Auto-paginate a list endpoint for full-catalog sync.
 */
async function paginate<Raw>(
  path: string,
  extra?: Record<string, string>,
): Promise<Raw[]> {
  const items: Raw[] = [];
  let page = 1;

  while (true) {
    const params: Record<string, string> = {
      limit: String(PER_PAGE),
      page: String(page),
      ...extra,
    };

    const response = await keycrmGet<PaginatedResponse<Raw>>(path, params);

    if (page === 1) {
      log.info({ path, total: response.total }, 'Paginating KeyCRM endpoint');
    }

    items.push(...response.data);

    log.info(
      { path, page, fetched: response.data.length, accumulated: items.length, total: response.total },
      'Page fetched',
    );

    if (!response.next_page_url || response.data.length === 0) {
      break;
    }

    page++;
  }

  log.info({ path, totalItems: items.length }, 'Pagination complete');
  return items;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export const keycrmAdapter: CrmAdapter = {
  name: 'keycrm',

  async fetchCategories() {
    log.info('Fetching categories from KeyCRM');
    const raw = await paginate<RawCategory>('/products/categories');
    return raw.map(mapCategory);
  },

  async fetchProducts() {
    log.info('Fetching products from KeyCRM');
    const raw = await paginate<RawProduct>('/products');
    return raw.map(mapProduct);
  },

  async fetchOffers() {
    log.info('Fetching offers from KeyCRM');
    const raw = await paginate<RawOffer>('/offers', { include: 'product' });
    return raw.map(mapOffer);
  },

  async searchProducts({ nameQuery, activeOnly = true, limit = 5 }) {
    const params: Record<string, string> = {
      limit: String(limit),
      page: '1',
    };
    if (nameQuery) params['filter[name]'] = nameQuery;
    if (activeOnly) params['filter[is_archived]'] = '0';

    const result = await keycrmGet<PaginatedResponse<RawProduct>>('/products', params, {
      retry: false,
    });
    return result.data.map(mapProduct);
  },

  async searchOffers({ productId, activeOnly = true, limit = 10 }) {
    const params: Record<string, string> = {
      limit: String(limit),
      page: '1',
    };
    if (productId !== undefined) params['filter[product_id]'] = String(productId);
    if (activeOnly) params['filter[is_archived]'] = '0';

    const result = await keycrmGet<PaginatedResponse<RawOffer>>('/offers', params, {
      retry: false,
    });
    return result.data.map(mapOffer);
  },

  async findClient(match: CrmClientMatch) {
    // 1) Trusted local cross-ref — return immediately, don't pay a round-trip.
    //    The cache is invalidated by the caller if a subsequent PUT 404s.
    if (match.crmBuyerId) {
      return { crmBuyerId: match.crmBuyerId };
    }

    // 2) Phone — KeyCRM stores multiple phones per buyer and allows filter
    //    by any of them. Most reliable match after local crmBuyerId.
    if (match.phone) {
      const phone = match.phone.trim();
      if (phone) {
        try {
          const r = await keycrmGet<PaginatedResponse<RawBuyer>>(
            '/buyer',
            { limit: '1', page: '1', 'filter[buyer_phone]': phone },
            { retry: false },
          );
          if (r.data.length > 0) {
            return { crmBuyerId: String(r.data[0].id) };
          }
        } catch (err) {
          log.warn({ err, phone }, 'KeyCRM findClient by phone failed — falling through');
        }
      }
    }

    // 3) Email fallback.
    if (match.email) {
      const email = match.email.trim().toLowerCase();
      if (email) {
        try {
          const r = await keycrmGet<PaginatedResponse<RawBuyer>>(
            '/buyer',
            { limit: '1', page: '1', 'filter[buyer_email]': email },
            { retry: false },
          );
          if (r.data.length > 0) {
            return { crmBuyerId: String(r.data[0].id) };
          }
        } catch (err) {
          log.warn({ err, email }, 'KeyCRM findClient by email failed — falling through');
        }
      }
    }

    // Instagram handle match: KeyCRM has no native filter on /buyer for IG.
    // The bot keeps the crmBuyerId ↔ igUsername link in its own Client table,
    // so if we get here with only an instagramUsername we haven't seen before,
    // the correct behaviour is to return null (→ caller will create a new
    // buyer and persist the crmBuyerId locally, closing the loop next time).
    return null;
  },

  async upsertClient(crmBuyerId: string | null, input: CrmClientInput) {
    const body: Record<string, unknown> = {
      full_name: input.fullName,
    };
    if (input.email) body.email = [input.email];
    if (input.phone) body.phone = [input.phone];

    // IG handle fallback: if the shop hasn't configured a dedicated custom
    // field for Instagram, stash it in the buyer note so managers can still
    // see it. Opt-in via a distinct marker line that's easy to grep out
    // later if migrating to a real custom field.
    const noteParts: string[] = [];
    if (input.note) noteParts.push(input.note);
    if (input.instagramUsername) {
      noteParts.push(`Instagram: @${input.instagramUsername.replace(/^@/, '')}`);
    }
    if (noteParts.length > 0) body.note = noteParts.join('\n\n');

    if (input.shipping) {
      const s: Record<string, unknown> = {};
      if (input.shipping.city) s.city = input.shipping.city;
      if (input.shipping.address) s.address = input.shipping.address;
      if (input.shipping.warehouseRef) s.warehouse_ref = input.shipping.warehouseRef;
      if (Object.keys(s).length > 0) body.shipping = [s];
    }

    if (input.customFields && input.customFields.length > 0) {
      body.custom_fields = input.customFields.map((f) => ({ uuid: f.key, value: f.value }));
    }

    const path = crmBuyerId ? `/buyer/${crmBuyerId}` : '/buyer';
    const method = crmBuyerId ? 'PUT' : 'POST';

    log.info({ method, path, hasIg: !!input.instagramUsername }, 'KeyCRM upsertClient');
    const res = await keycrmJson<RawBuyer>(method, path, body);
    return { crmBuyerId: String(res.id) };
  },

  async createOrder(input: CrmOrderInput) {
    const body: Record<string, unknown> = {
      source_id: input.sourceId ?? config.KEYCRM_DEFAULT_SOURCE_ID,
      buyer: {
        full_name: input.buyer.fullName,
        ...(input.buyer.phone ? { phone: input.buyer.phone } : {}),
        ...(input.buyer.email ? { email: input.buyer.email } : {}),
      },
      products: input.items.map((item) => ({
        name: item.name,
        price: item.price,
        quantity: item.qty,
        ...(item.variant ? { properties: [{ name: 'variant', value: item.variant }] } : {}),
      })),
    };

    if (input.shipping) {
      body.shipping = {
        shipping_address_city: input.shipping.city,
        shipping_receive_point: input.shipping.npBranch,
        shipping_service: 'Нова Пошта',
      };
    }

    if (input.note) body.manager_comment = input.note;

    if (input.customFields && input.customFields.length > 0) {
      body.custom_fields = input.customFields.map((f) => ({ uuid: f.key, value: f.value }));
    }

    log.info(
      { sourceId: body.source_id, items: input.items.length },
      'KeyCRM createOrder',
    );
    const res = await keycrmJson<{ id: number }>('POST', '/order', body);
    return { crmOrderId: String(res.id) };
  },

  async createLead(input: CrmLeadInput) {
    // KeyCRM /pipelines/cards returns 400 "Leads are not enabled" if the
    // workspace doesn't have pipelines activated. Caller should catch &
    // fall back to createOrder (or Telegram-only notification) in that case.
    const contact: Record<string, unknown> = {};
    if (input.crmBuyerId) contact.client_id = Number(input.crmBuyerId);
    if (input.contact.fullName) contact.full_name = input.contact.fullName;
    if (input.contact.phone) contact.phone = input.contact.phone;
    if (input.contact.email) contact.email = input.contact.email;

    const body: Record<string, unknown> = {
      source_id: input.sourceId ?? config.KEYCRM_DEFAULT_SOURCE_ID,
      contact,
    };
    if (input.title) body.title = input.title;
    if (input.managerComment) body.manager_comment = input.managerComment;
    const pipelineId = input.pipelineId ?? config.KEYCRM_LEAD_PIPELINE_ID;
    if (pipelineId > 0) body.pipeline_id = pipelineId;

    if (input.customFields && input.customFields.length > 0) {
      body.custom_fields = input.customFields.map((f) => ({
        uuid: f.key,
        value: f.value,
      }));
    }

    log.info(
      { pipelineId, hasBuyer: !!input.crmBuyerId, customFields: input.customFields?.length ?? 0 },
      'KeyCRM createLead',
    );
    const res = await keycrmJson<{ id: number }>('POST', '/pipelines/cards', body);
    return { crmLeadId: String(res.id) };
  },

  async listCustomFields(
    scope: 'buyer' | 'order' | 'lead',
  ): Promise<CrmCustomFieldDef[]> {
    // KeyCRM calls the buyer entity "client" in the custom-fields endpoint.
    // Pipeline-card custom fields are filed under the "lead" model.
    const model =
      scope === 'buyer' ? 'client' : scope === 'lead' ? 'lead' : 'order';

    const raw = await keycrmGet<RawCustomField[]>(
      '/custom-fields',
      { 'filter[model]': model, include: 'options' },
      { retry: false },
    );

    return raw.map((f) => ({
      key: f.uuid,
      name: f.name,
      scope,
      type: f.type,
      options: (f.options ?? []).map((o) => o.value),
    }));
  },
};
