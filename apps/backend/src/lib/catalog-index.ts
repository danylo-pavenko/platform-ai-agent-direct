/**
 * In-memory index over catalog JSON dumps:
 * - CRM sync: data/products.json + offers.json
 * - Manual CSV: data/manual-products.json + manual-offers.json
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import {
  getManualOffersPath,
  getManualProductsPath,
  REPO_ROOT,
} from './paths.js';
import type { CrmOffer, CrmProduct } from '../services/crm/types.js';

const log = pino({ name: 'catalog-index' });

const DATA_DIR = resolve(REPO_ROOT, 'data');

export interface CatalogIndex {
  mtimeMs: number;
  products: CrmProduct[];
  offersByProductId: Map<number, CrmOffer[]>;
  source: 'crm' | 'manual';
}

let crmCache: CatalogIndex | null = null;
let manualCache: CatalogIndex | null = null;

export function invalidateCatalogIndexCache(): void {
  crmCache = null;
  manualCache = null;
}

async function loadIndexFromFiles(
  productsPath: string,
  offersPath: string,
  source: 'crm' | 'manual',
  cache: CatalogIndex | null,
): Promise<CatalogIndex | null> {
  try {
    const [productStat, offerStat] = await Promise.all([stat(productsPath), stat(offersPath)]);
    const mtimeMs = Math.max(productStat.mtimeMs, offerStat.mtimeMs);

    if (cache && cache.mtimeMs === mtimeMs && cache.source === source) {
      return cache;
    }

    const [productsRaw, offersRaw] = await Promise.all([
      readFile(productsPath, 'utf8'),
      readFile(offersPath, 'utf8'),
    ]);

    const products = JSON.parse(productsRaw) as CrmProduct[];
    const offers = JSON.parse(offersRaw) as CrmOffer[];
    const offersByProductId = new Map<number, CrmOffer[]>();

    for (const offer of offers) {
      const bucket = offersByProductId.get(offer.productId);
      if (bucket) bucket.push(offer);
      else offersByProductId.set(offer.productId, [offer]);
    }

    const next: CatalogIndex = { mtimeMs, products, offersByProductId, source };
    log.debug(
      { products: products.length, offers: offers.length, source },
      'Catalog index loaded from disk',
    );
    return next;
  } catch (err) {
    log.debug({ err, source }, 'Catalog index unavailable');
    return null;
  }
}

/** KeyCRM (or other CRM sync) snapshot. */
export async function loadCatalogIndex(): Promise<CatalogIndex | null> {
  const index = await loadIndexFromFiles(
    resolve(DATA_DIR, 'products.json'),
    resolve(DATA_DIR, 'offers.json'),
    'crm',
    crmCache,
  );
  crmCache = index;
  return index;
}

/** Manual CSV import snapshot. */
export async function loadManualCatalogIndex(): Promise<CatalogIndex | null> {
  const index = await loadIndexFromFiles(
    getManualProductsPath(),
    getManualOffersPath(),
    'manual',
    manualCache,
  );
  manualCache = index;
  return index;
}

/** Tokenize a product search query (Cyrillic + Latin, min 2 chars). */
export function tokenizeProductQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export function scoreProductNameMatch(
  productNameLower: string,
  tokens: string[],
  fullQueryLower: string,
): number {
  if (!productNameLower || tokens.length === 0) return 0;

  let matched = 0;
  for (const token of tokens) {
    if (productNameLower.includes(token)) matched++;
  }
  if (matched === 0) return 0;

  let score = matched / tokens.length;
  if (fullQueryLower && productNameLower.includes(fullQueryLower)) {
    score += 0.5;
  }
  return score;
}

/** Rank active products from the local sync snapshot. */
export function searchLocalProducts(
  products: CrmProduct[],
  query: string,
  limit: number,
): CrmProduct[] {
  const tokens = tokenizeProductQuery(query);
  if (tokens.length === 0) return [];

  const fullQueryLower = query.trim().toLowerCase();
  const ranked: Array<{ product: CrmProduct; score: number }> = [];

  for (const product of products) {
    if (product.isArchived) continue;
    const name = (product.name ?? '').toLowerCase();
    const score = scoreProductNameMatch(name, tokens, fullQueryLower);
    if (score > 0) ranked.push({ product, score });
  }

  ranked.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name, 'uk'));
  return ranked.slice(0, limit).map((row) => row.product);
}
