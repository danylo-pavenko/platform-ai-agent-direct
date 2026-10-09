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

const GARMENT_PREFIXES = [
  'футбол',
  'худі',
  'худи',
  'світшот',
  'лонг',
  'сороч',
  'шопер',
  'кепк',
  'зіп',
];

/** Color, size, and garment words are not a design name. */
const NON_DESIGN_PREFIXES = [
  ...GARMENT_PREFIXES,
  'чорн',
  'біл',
  'молоч',
  'беж',
  'сір',
  'син',
  'рожев',
  'шоколад',
  'вишн',
  'хакі',
  'зелен',
  'блакит',
  'багрян',
  'слонов',
  'оверсайз',
  'унісекс',
  'розмір',
  'xs',
  'sm',
  'ml',
  'xl',
  'xxl',
  '2xl',
];

function isGarmentToken(token: string): boolean {
  return GARMENT_PREFIXES.some((prefix) => token.startsWith(prefix));
}

const DESIGN_PHRASE_ALIASES: Record<string, string> = {
  blessed: 'благословенний',
  благословенний: 'благословенний',
};

function normalizeDesignPhrase(phrase: string): string {
  const compact = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  return DESIGN_PHRASE_ALIASES[compact] ?? compact;
}

/** Quoted print, or a bare “Blessed” that Shop-Express left outside quotes. */
export function designKeyFromName(name: string): string | null {
  const quoted = name.match(/["«“]([^"»”]+)["»”]/);
  if (quoted?.[1]?.trim()) return normalizeDesignPhrase(quoted[1]);
  if (/(^|[^a-z])blessed([^a-z]|$)/i.test(name)) return 'благословенний';
  return null;
}

export function garmentFamily(name: string): string | null {
  const lower = name.toLowerCase();
  for (const prefix of GARMENT_PREFIXES) {
    if (lower.includes(prefix)) return prefix;
  }
  return null;
}

/**
 * Colorways of one print are often separate Shop-Express products
 * («Худі чорний "Благословенний"» and «Худі (вишня) Blessed»).
 * Pull the rest of that garment+print so search does not show a single color.
 */
export function designColorSiblings(all: CrmProduct[], hitNames: string[]): CrmProduct[] {
  const keys = new Set<string>();
  for (const name of hitNames) {
    const design = designKeyFromName(name);
    const garment = garmentFamily(name);
    if (design && garment) keys.add(`${garment}::${design}`);
  }
  if (keys.size === 0) return [];

  const seen = new Set(hitNames.map((name) => name.toLowerCase()));
  const extras: CrmProduct[] = [];
  for (const product of all) {
    if (product.isArchived) continue;
    const name = product.name ?? '';
    if (!name || seen.has(name.toLowerCase())) continue;
    const design = designKeyFromName(name);
    const garment = garmentFamily(name);
    if (!design || !garment || !keys.has(`${garment}::${design}`)) continue;
    seen.add(name.toLowerCase());
    extras.push(product);
    if (extras.length >= 24) break;
  }
  return extras;
}

function matchesDesign(productNameLower: string, designTokens: string[]): boolean {
  const strong = designTokens.filter((token) => token.length >= 5);
  const required = strong.length > 0 ? strong : designTokens;
  return required.every((token) => tokenInProductName(productNameLower, token));
}

function isDesignToken(token: string): boolean {
  if (token.length < 3) return false;
  if (isGarmentToken(token)) return false;
  return !NON_DESIGN_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/** Exact substring, or a short Ukrainian stem so «дорогоцінна» hits «Дорогоцінний». */
export function tokenInProductName(productNameLower: string, token: string): boolean {
  if (productNameLower.includes(token)) return true;
  if (token.length >= 7 && /[а-яіїєґ]/i.test(token)) {
    const stem = token.slice(0, -2);
    if (stem.length >= 5 && productNameLower.includes(stem)) return true;
  }
  return false;
}

export function scoreProductNameMatch(
  productNameLower: string,
  tokens: string[],
  fullQueryLower: string,
): number {
  if (!productNameLower || tokens.length === 0) return 0;

  let matched = 0;
  for (const token of tokens) {
    if (tokenInProductName(productNameLower, token)) matched++;
  }
  if (matched === 0) return 0;

  let score = matched / tokens.length;
  if (fullQueryLower && productNameLower.includes(fullQueryLower)) {
    score += 0.5;
  }
  return score;
}

/**
 * The asked-for print exists only on another garment.
 * «Chosen» on a t-shirt is not «Child of God» hoodie.
 */
export function designGarmentMismatchNote(query: string, productNames: string[]): string | null {
  const tokens = tokenizeProductQuery(query);
  const designTokens = tokens.filter(isDesignToken);
  const garmentTokens = tokens.filter(isGarmentToken);
  if (designTokens.length === 0 || garmentTokens.length === 0 || productNames.length === 0) {
    return null;
  }
  const names = productNames.map((name) => name.toLowerCase());
  const designHits = names.filter((name) => matchesDesign(name, designTokens));
  if (designHits.length === 0) return null;
  const sameGarment = designHits.some((name) =>
    garmentTokens.some((token) => tokenInProductName(name, token)),
  );
  if (sameGarment) return null;
  return (
    'УВАГА: напис із запиту є в каталозі, але на іншому типі виробу. ' +
    'Не називай це тим самим товаром на запитуваному виробі і не підміняй іншим дизайном. ' +
    'Той самий напис на іншому виробі — індивідуальне замовлення, не ціна готової позиції.'
  );
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
  const designTokens = tokens.filter(isDesignToken);
  const ranked: Array<{ product: CrmProduct; score: number }> = [];

  for (const product of products) {
    if (product.isArchived) continue;
    const name = (product.name ?? '').toLowerCase();
    const score = scoreProductNameMatch(name, tokens, fullQueryLower);
    if (score > 0) ranked.push({ product, score });
  }

  let pool = ranked;
  if (designTokens.length > 0) {
    const withDesign = ranked.filter((row) =>
      matchesDesign((row.product.name ?? '').toLowerCase(), designTokens),
    );
    if (withDesign.length > 0) pool = withDesign;
  }

  pool.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name, 'uk'));
  return pool.slice(0, limit).map((row) => row.product);
}
