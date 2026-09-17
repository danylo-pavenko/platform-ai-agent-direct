/**
 * product-search.ts
 *
 * Product availability for the sales agent.
 *
 * - sourcePriority: which index to search first / prompt snippet
 * - pricePreference: which price to quote when file↔CRM are matched
 * Searches both indexes when both exist and merges via catalog-matches.json.
 */

import pino from 'pino';
import {
  loadCatalogIndex,
  loadManualCatalogIndex,
  searchLocalProducts,
  type CatalogIndex,
} from '../lib/catalog-index.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmOffer, CrmProduct } from './crm/index.js';
import { getCatalogImportSettings } from './catalog-import/import-catalog.js';
import { loadCatalogMatches } from './catalog-import/catalog-match.js';
import type {
  CatalogPricePreference,
  CatalogProductMatch,
} from './catalog-import/types.js';

const log = pino({ name: 'product-search' });

const MAX_PRODUCT_RESULTS = 5;
const MAX_OFFERS_PER_PRODUCT = 10;
const ALT_PRICE_ABS = 50;
const ALT_PRICE_PCT = 0.05;

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

function midPrice(min: number | null, max: number | null): number | null {
  if (min == null && max == null) return null;
  if (min == null) return max;
  if (max == null) return min;
  return (min + max) / 2;
}

function pricesDifferMaterially(
  a: number | null,
  b: number | null,
): boolean {
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  if (diff < ALT_PRICE_ABS) return false;
  const base = Math.max(a, b, 1);
  return diff / base >= ALT_PRICE_PCT || diff >= ALT_PRICE_ABS;
}

function activeOffersForProduct(
  offers: CrmOffer[],
  maxPerProduct: number,
): CrmOffer[] {
  return offers
    .filter((o) => !o.isArchived && o.quantity - o.inReserve > 0)
    .slice(0, maxPerProduct);
}

type RankedHit = {
  key: string;
  displayName: string;
  offers: CrmOffer[];
  quantity: number;
  canonicalMin: number | null;
  canonicalMax: number | null;
  priceSource: 'file' | 'crm';
  altMin: number | null;
  altMax: number | null;
  matchConfidence: 'high' | 'medium' | null;
  score: number;
};

function buildMergedContext(
  keywords: string,
  hits: RankedHit[],
): ProductAvailabilityResult {
  const productLines: string[] = [];

  for (const hit of hits) {
    const activeOffers = activeOffersForProduct(hit.offers, MAX_OFFERS_PER_PRODUCT);
    if (activeOffers.length === 0 && hit.quantity <= 0) continue;

    const priceStr = formatPrice(hit.canonicalMin, hit.canonicalMax);
    const priceLabel = hit.priceSource === 'file' ? 'ціна з файлу' : 'ціна з CRM';
    const confNote =
      hit.matchConfidence === 'medium'
        ? ' | match: medium — уточни розмір/модель, якщо кілька схожих'
        : '';

    if (activeOffers.length === 0) {
      productLines.push(
        `• ${hit.displayName} | ${priceStr} (${priceLabel}) | В наявності: ${hit.quantity} шт${confNote}`,
      );
    } else {
      const variantLines = activeOffers.map((offer) => {
        const variantDesc = formatVariantProps(offer.properties);
        const available = offer.quantity - offer.inReserve;
        return `  – ${variantDesc || 'без варіанту'} | ${offer.price}₴ | ${available} шт`;
      });
      productLines.push(
        `• ${hit.displayName} | ${priceStr} (${priceLabel})${confNote}\n${variantLines.join('\n')}`,
      );
    }

    const canonMid = midPrice(hit.canonicalMin, hit.canonicalMax);
    const altMid = midPrice(hit.altMin, hit.altMax);
    if (pricesDifferMaterially(canonMid, altMid)) {
      const altLabel = hit.priceSource === 'file' ? 'CRM' : 'файл';
      productLines.push(
        `  (${altLabel}: ${formatPrice(hit.altMin, hit.altMax)} — різниця; клієнту кажи канонічну ${priceStr})`,
      );
    }
  }

  if (productLines.length === 0) {
    return { contextBlock: '', matchCount: 0 };
  }

  const contextBlock = [
    `Знайдено в каталозі (за запитом "${keywords}"):`,
    productLines.join('\n'),
    '(Ціна канонічна за налаштуванням pricePreference; наявність з обраного джерела варіантів)',
  ].join('\n');

  return { contextBlock, matchCount: hits.length };
}

function scoreName(productName: string, keywords: string): number {
  const tokens = keywords
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;
  const name = productName.toLowerCase();
  let matched = 0;
  for (const t of tokens) if (name.includes(t)) matched += 1;
  if (matched === 0) return 0;
  let score = matched / tokens.length;
  if (name.includes(keywords.trim().toLowerCase())) score += 0.5;
  return score;
}

function pickCanonical(
  pricePreference: CatalogPricePreference,
  fileProduct: CrmProduct | null,
  crmProduct: CrmProduct | null,
): {
  displayName: string;
  canonicalMin: number | null;
  canonicalMax: number | null;
  priceSource: 'file' | 'crm';
  altMin: number | null;
  altMax: number | null;
  offers: CrmOffer[];
  quantity: number;
} {
  const preferFile = pricePreference === 'file';
  const primary = preferFile ? fileProduct : crmProduct;
  const secondary = preferFile ? crmProduct : fileProduct;
  const primarySource: 'file' | 'crm' = preferFile ? 'file' : 'crm';

  const chosen = primary ?? secondary;
  const other = primary ? secondary : null;
  const priceSource: 'file' | 'crm' =
    primary != null ? primarySource : preferFile ? 'crm' : 'file';

  return {
    displayName: chosen?.name ?? 'Товар',
    canonicalMin: chosen?.minPrice ?? null,
    canonicalMax: chosen?.maxPrice ?? null,
    priceSource,
    altMin: other?.minPrice ?? null,
    altMax: other?.maxPrice ?? null,
    offers: [],
    quantity: chosen?.quantity ?? 0,
  };
}

async function searchMerged(
  keywords: string,
  pricePreference: CatalogPricePreference,
  primary: 'file' | 'crm',
): Promise<ProductAvailabilityResult | null> {
  const [manual, crm, matches] = await Promise.all([
    loadManualCatalogIndex(),
    loadCatalogIndex(),
    loadCatalogMatches(),
  ]);

  if (!manual && !crm) return null;

  const matchByManual = new Map(matches.map((m) => [m.manualProductId, m]));
  const matchByCrm = new Map(matches.map((m) => [m.crmProductId, m]));

  const primaryIndex = primary === 'file' ? manual : crm;
  const secondaryIndex = primary === 'file' ? crm : manual;
  if (!primaryIndex && !secondaryIndex) return null;

  const primaryProducts = primaryIndex
    ? searchLocalProducts(primaryIndex.products, keywords, MAX_PRODUCT_RESULTS * 2)
    : [];
  const secondaryProducts = secondaryIndex
    ? searchLocalProducts(secondaryIndex.products, keywords, MAX_PRODUCT_RESULTS)
    : [];

  const seen = new Set<string>();
  const hits: RankedHit[] = [];

  function pushHit(
    fileProduct: CrmProduct | null,
    crmProduct: CrmProduct | null,
    link: CatalogProductMatch | null,
    score: number,
  ) {
    const key =
      fileProduct && crmProduct
        ? `pair:${fileProduct.id}:${crmProduct.id}`
        : fileProduct
          ? `file:${fileProduct.id}`
          : `crm:${crmProduct!.id}`;
    if (seen.has(key)) return;
    seen.add(key);

    const canon = pickCanonical(pricePreference, fileProduct, crmProduct);
    const offerIndex =
      canon.priceSource === 'file' ? manual : crm;
    const productForOffers =
      canon.priceSource === 'file' ? fileProduct : crmProduct;
    const offers =
      offerIndex && productForOffers
        ? offerIndex.offersByProductId.get(productForOffers.id) ?? []
        : [];

    // Prefer stock from offer source; fall back
    let quantity = productForOffers?.quantity ?? 0;
    if (quantity <= 0 && fileProduct) quantity = fileProduct.quantity;
    if (quantity <= 0 && crmProduct) quantity = crmProduct.quantity;

    hits.push({
      key,
      displayName: canon.displayName,
      offers,
      quantity,
      canonicalMin: canon.canonicalMin,
      canonicalMax: canon.canonicalMax,
      priceSource: canon.priceSource,
      altMin: canon.altMin,
      altMax: canon.altMax,
      matchConfidence: link?.confidence ?? null,
      score,
    });
  }

  if (primary === 'file' && manual) {
    for (const p of primaryProducts) {
      const link = matchByManual.get(p.id) ?? null;
      const crmP =
        link && crm
          ? crm.products.find((x) => x.id === link.crmProductId) ?? null
          : null;
      pushHit(p, crmP, link, scoreName(p.name, keywords) + 1);
    }
  } else if (crm) {
    for (const p of primaryProducts) {
      const link = matchByCrm.get(p.id) ?? null;
      const fileP =
        link && manual
          ? manual.products.find((x) => x.id === link.manualProductId) ?? null
          : null;
      pushHit(fileP, p, link, scoreName(p.name, keywords) + 1);
    }
  }

  // Secondary-only hits not already paired
  if (primary === 'file' && crm) {
    for (const p of secondaryProducts) {
      const link = matchByCrm.get(p.id);
      if (link && seen.has(`pair:${link.manualProductId}:${p.id}`)) continue;
      if (link && seen.has(`file:${link.manualProductId}`)) continue;
      const fileP = link
        ? manual?.products.find((x) => x.id === link.manualProductId) ?? null
        : null;
      if (fileP && seen.has(`file:${fileP.id}`)) continue;
      pushHit(fileP, p, link ?? null, scoreName(p.name, keywords));
    }
  } else if (primary === 'crm' && manual) {
    for (const p of secondaryProducts) {
      const link = matchByManual.get(p.id);
      if (link && seen.has(`pair:${p.id}:${link.crmProductId}`)) continue;
      const crmP = link
        ? crm?.products.find((x) => x.id === link.crmProductId) ?? null
        : null;
      pushHit(p, crmP, link ?? null, scoreName(p.name, keywords));
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, MAX_PRODUCT_RESULTS);
  if (top.length === 0) return null;

  const result = buildMergedContext(keywords, top);
  if (result.matchCount === 0) return null;
  log.info(
    { keywords, found: result.matchCount, primary, pricePreference },
    'Product search served from merged catalog',
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

  const hits: RankedHit[] = activeProducts.map((product) => ({
    key: `crm:${product.id}`,
    displayName: product.name,
    offers: offersByProductId.get(product.id) ?? [],
    quantity: product.quantity,
    canonicalMin: product.minPrice,
    canonicalMax: product.maxPrice,
    priceSource: 'crm' as const,
    altMin: null,
    altMax: null,
    matchConfidence: null,
    score: 1,
  }));

  return buildMergedContext(keywords, hits);
}

export async function isCrmCatalogAvailable(): Promise<boolean> {
  const cfg = await getIntegrationConfig();
  if (cfg.keycrm?.apiKey?.trim()) return true;
  const index = await loadCatalogIndex();
  return Boolean(index && index.products.length > 0);
}

export async function resolveEffectiveCatalogSource(): Promise<'file' | 'crm'> {
  const crmOk = await isCrmCatalogAvailable();
  if (!crmOk) return 'file';
  const settings = await getCatalogImportSettings();
  return settings.sourcePriority === 'crm' ? 'crm' : 'file';
}

export interface ProductAvailabilityResult {
  contextBlock: string;
  matchCount: number;
}

export async function searchActiveProductsForContext(
  keywords: string,
): Promise<ProductAvailabilityResult> {
  const cleanKeywords = keywords.trim().slice(0, 100);
  if (!cleanKeywords) {
    return { contextBlock: '', matchCount: 0 };
  }

  const settings = await getCatalogImportSettings();
  const primary = await resolveEffectiveCatalogSource();
  const pricePreference =
    settings.pricePreference === 'crm' || settings.pricePreference === 'file'
      ? settings.pricePreference
      : primary;

  const merged = await searchMerged(cleanKeywords, pricePreference, primary);
  if (merged) return merged;

  if (primary === 'file') {
    return {
      contextBlock:
        'Каталог порожній або нічого не знайдено. Імпортуйте CSV / синхронізуйте CRM або уточніть запит.',
      matchCount: 0,
    };
  }

  return searchViaCrmApi(cleanKeywords);
}

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
