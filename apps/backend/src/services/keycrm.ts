import pino from 'pino';
import { config } from '../config.js';

const log = pino({ name: 'keycrm' });

const BASE_URL = 'https://openapi.keycrm.app/v1';
const MAX_RETRIES = 3;
const PACING_MS = 150;
const PER_PAGE = 50;

// ── Types ───────────────────────────────────────────────────────────────────

export interface KeycrmCategory {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface KeycrmProduct {
  id: number;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  attachments_data: string[];
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

export interface KeycrmOffer {
  id: number;
  product_id: number;
  sku: string | null;
  barcode: string | null;
  thumbnail_url: string | null;
  price: number;
  purchased_price: number;
  quantity: number;
  in_reserve: number;
  properties: Array<{ name: string; value: string }>;
  is_archived: boolean;
  product?: KeycrmProduct;
}

interface PaginatedResponse<T> {
  total: number;
  current_page: number;
  per_page: number;
  next_page_url: string | null;
  data: T[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Low-level GET request to KeyCRM with retry on 429 / 5xx and pacing.
 */
async function keycrmGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Pacing — respect 60 req/min rate limit
    if (attempt > 1) {
      const backoff = PACING_MS * Math.pow(2, attempt - 1);
      log.warn({ attempt, backoff }, 'Retrying after backoff');
      await sleep(backoff);
    } else {
      await sleep(PACING_MS);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.KEYCRM_API_KEY}`,
        Accept: 'application/json',
      },
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const status = response.status;
    const body = await response.text();

    // Retryable: 429 (rate limit) or 5xx (server error)
    if (status === 429 || status >= 500) {
      lastError = new Error(
        `KeyCRM ${status} on ${path}: ${body.slice(0, 200)}`,
      );
      log.warn({ status, path, attempt }, 'Retryable error from KeyCRM');
      continue;
    }

    // Non-retryable 4xx — throw immediately
    throw new Error(`KeyCRM ${status} on ${path}: ${body.slice(0, 500)}`);
  }

  throw lastError ?? new Error(`KeyCRM request failed after ${MAX_RETRIES} retries`);
}

/**
 * Auto-paginate a KeyCRM list endpoint, collecting all items.
 */
async function paginate<T>(
  path: string,
  extra?: Record<string, string>,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params: Record<string, string> = {
      limit: String(PER_PAGE),
      page: String(page),
      ...extra,
    };

    const response = await keycrmGet<PaginatedResponse<T>>(path, params);

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

// ── Public API ──────────────────────────────────────────────────────────────

export async function fetchCategories(): Promise<KeycrmCategory[]> {
  log.info('Fetching categories from KeyCRM');
  return paginate<KeycrmCategory>('/products/categories');
}

export async function fetchProducts(): Promise<KeycrmProduct[]> {
  log.info('Fetching products from KeyCRM');
  return paginate<KeycrmProduct>('/products');
}

export async function fetchOffers(): Promise<KeycrmOffer[]> {
  log.info('Fetching offers from KeyCRM');
  return paginate<KeycrmOffer>('/offers', { include: 'product' });
}
