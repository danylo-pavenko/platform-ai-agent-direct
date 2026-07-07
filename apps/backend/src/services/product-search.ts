/**
 * product-search.ts
 *
 * Product availability lookup for the sales agent.
 *
 * Fast path: search the local sync snapshot (data/products.json + offers.json)
 * — no KeyCRM HTTP, typically <5ms.
 *
 * Fallback: live KeyCRM API when the snapshot is missing, with batched offer
 * fetch (1 products query + 1 offers query instead of N+1).
 */

import pino from 'pino';
import { loadCatalogIndex, searchLocalProducts } from '../lib/catalog-index.js';
import { getCrmAdapter } from './crm/index.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import type { CrmOffer, CrmProduct } from './crm/index.js';

const log = pino({ name: 'product-search' });

const MAX_PRODUCT_RESULTS = 5;
const MAX_OFFERS_PER_PRODUCT = 10;

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatVariantProps(properties: CrmOffer['properties']): string {
  if (!properties || properties.length === 0) return '';
  return properties.map((p) => `${p.name}: ${p.value}`).join(', ');
}

function formatPrice(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'ціна уточнюється';
  if (min === null) return `${max}₴`;
  if (max === null || min === max) return `${min}₴`;
  return `${min}–${max}₴`;
}

function activeOffersForProduct(
  offers: CrmOffer[],
  maxPerProduct: number,
): CrmOffer[] {
  return offers
    .filter((o) => !o.isArchived && o.quantity - o.inReserve > 0)
    .slice(0, maxPerProduct);
}

function buildContextFromMatches(
  keywords: string,
  matches: Array<{ product: CrmProduct; offers: CrmOffer[] }>,
  source: 'local' | 'crm',
): ProductAvailabilityResult {
  const productLines: string[] = [];

  for (const { product, offers } of matches) {
    const activeOffers = activeOffersForProduct(offers, MAX_OFFERS_PER_PRODUCT);

    if (activeOffers.length === 0 && product.quantity <= 0) {
      continue;
    }

    const priceStr = formatPrice(product.minPrice, product.maxPrice);

    if (activeOffers.length === 0) {
      productLines.push(
        `• ${product.name} | ${priceStr} | В наявності: ${product.quantity} шт`,
      );
    } else {
      const variantLines = activeOffers.map((offer) => {
        const variantDesc = formatVariantProps(offer.properties);
        const available = offer.quantity - offer.inReserve;
        return `  – ${variantDesc || 'без варіанту'} | ${offer.price}₴ | ${available} шт`;
      });

      productLines.push(
        `• ${product.name} | від ${priceStr}\n${variantLines.join('\n')}`,
      );
    }
  }

  if (productLines.length === 0) {
    return { contextBlock: '', matchCount: 0 };
  }

  const freshness =
    source === 'local'
      ? '(Наявність з останньої синхронізації каталогу)'
      : '(Дані про наявність актуальні на момент запиту)';

  const contextBlock = [
    `Знайдено в каталозі (за запитом "${keywords}"):`,
    productLines.join('\n'),
    freshness,
  ].join('\n');

  return { contextBlock, matchCount: productLines.length };
}

async function searchViaLocalIndex(
  keywords: string,
): Promise<ProductAvailabilityResult | null> {
  const index = await loadCatalogIndex();
  if (!index) return null;

  const products = searchLocalProducts(index.products, keywords, MAX_PRODUCT_RESULTS);
  if (products.length === 0) return null;

  const matches = products.map((product) => ({
    product,
    offers: index.offersByProductId.get(product.id) ?? [],
  }));

  const result = buildContextFromMatches(keywords, matches, 'local');
  if (result.matchCount === 0) return null;

  log.info(
    { keywords, found: result.matchCount, source: 'local' },
    'Product search served from local catalog index',
  );
  return result;
}

async function searchViaCrmApi(keywords: string): Promise<ProductAvailabilityResult> {
  const provider = await resolveCrmProvider('catalog');
  const crm = getCrmAdapter(provider);
  log.info({ keywords, provider: crm.name }, 'Searching products via CRM API');

  let products: CrmProduct[];
  try {
    products = await crm.searchProducts({
      nameQuery: keywords,
      activeOnly: true,
      limit: MAX_PRODUCT_RESULTS,
    });
  } catch (err) {
    log.error({ err, keywords }, 'CRM product search failed');
    return { contextBlock: '', matchCount: 0 };
  }

  const activeProducts = products.filter((p) => !p.isArchived);
  if (activeProducts.length === 0) {
    return { contextBlock: '', matchCount: 0 };
  }

  const productIds = activeProducts.map((p) => p.id);
  let allOffers: CrmOffer[] = [];

  try {
    allOffers = await crm.searchOffers({
      productIds,
      activeOnly: true,
      limit: productIds.length * MAX_OFFERS_PER_PRODUCT,
    });
  } catch (err) {
    log.warn({ err, productIds }, 'Batched CRM offer fetch failed — using product qty only');
  }

  const offersByProductId = new Map<number, CrmOffer[]>();
  for (const offer of allOffers) {
    const bucket = offersByProductId.get(offer.productId);
    if (bucket) bucket.push(offer);
    else offersByProductId.set(offer.productId, [offer]);
  }

  const matches = activeProducts.map((product) => ({
    product,
    offers: offersByProductId.get(product.id) ?? [],
  }));

  const result = buildContextFromMatches(keywords, matches, 'crm');
  log.info(
    { keywords, found: result.matchCount, source: 'crm', apiCalls: 2 },
    'Product search served from CRM API',
  );
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ProductAvailabilityResult {
  contextBlock: string;
  matchCount: number;
}

/**
 * Searches for products matching keywords and returns a formatted block
 * for Claude (`search_catalog` tool or shared IG post enrichment).
 */
export async function searchActiveProductsForContext(
  keywords: string,
): Promise<ProductAvailabilityResult> {
  const cleanKeywords = keywords.trim().slice(0, 100);

  if (!cleanKeywords) {
    return { contextBlock: '', matchCount: 0 };
  }

  const local = await searchViaLocalIndex(cleanKeywords);
  if (local) return local;

  return searchViaCrmApi(cleanKeywords);
}

/**
 * Extracts meaningful keywords from an Instagram post caption.
 */
export function extractKeywordsFromCaption(caption: string): string {
  return caption
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\S+/g, '')
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
