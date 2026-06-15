/**
 * In-memory index over sync-worker JSON dumps (data/products.json, offers.json).
 * Avoids KeyCRM API round-trips on every search_catalog / shared-post lookup.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import { REPO_ROOT } from './paths.js';
import type { CrmOffer, CrmProduct } from '../services/crm/types.js';

const log = pino({ name: 'catalog-index' });

const DATA_DIR = resolve(REPO_ROOT, 'data');

export interface CatalogIndex {
  mtimeMs: number;
  products: CrmProduct[];
  offersByProductId: Map<number, CrmOffer[]>;
}

let cache: CatalogIndex | null = null;

export function invalidateCatalogIndexCache(): void {
  cache = null;
}

export async function loadCatalogIndex(): Promise<CatalogIndex | null> {
  const productsPath = resolve(DATA_DIR, 'products.json');
  const offersPath = resolve(DATA_DIR, 'offers.json');

  try {
    const [productStat, offerStat] = await Promise.all([stat(productsPath), stat(offersPath)]);
    const mtimeMs = Math.max(productStat.mtimeMs, offerStat.mtimeMs);

    if (cache && cache.mtimeMs === mtimeMs) {
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

    cache = { mtimeMs, products, offersByProductId };
    log.debug(
      { products: products.length, offers: offers.length },
      'Catalog index loaded from disk',
    );
    return cache;
  } catch (err) {
    log.debug({ err }, 'Catalog index unavailable — will use live CRM search');
    return null;
  }
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
