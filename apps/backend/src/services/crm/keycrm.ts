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
import { getIntegrationConfig } from '../../lib/integration-config.js';
import type {
  CrmAdapter,
  CrmCategory,
  CrmProduct,
  CrmOffer,
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

  // Phase 2: findClient / upsertClient / createOrder / listCustomFields
  // will be filled in a follow-up commit. Left undefined for now so
  // consumers can feature-detect with `if (adapter.upsertClient)`.
};
