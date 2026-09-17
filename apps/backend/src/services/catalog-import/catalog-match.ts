/**
 * Match manual CSV products to CRM catalog (SKU exact, then fuzzy name).
 * Persists to data/catalog-matches.json; manual overrides survive rebuild.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pino from 'pino';
import {
  getCatalogMatchesPath,
  getManualOffersPath,
  getManualProductsPath,
  REPO_ROOT,
} from '../../lib/paths.js';
import { resolve } from 'node:path';
import type { CrmOffer, CrmProduct } from '../crm/types.js';
import type {
  CatalogMatchConfidence,
  CatalogMatchMethod,
  CatalogProductMatch,
} from './types.js';

const log = pino({ name: 'catalog-match' });

const DATA_DIR = resolve(REPO_ROOT, 'data');

export function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function normalizeProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameMatchScore(a: string, b: string): number {
  const na = normalizeProductName(a);
  const nb = normalizeProductName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return Math.max(0.75, shorter / longer);
  }
  const ta = new Set(na.split(' ').filter((t) => t.length >= 3));
  const tb = new Set(nb.split(' ').filter((t) => t.length >= 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export async function loadCatalogMatches(): Promise<CatalogProductMatch[]> {
  try {
    const raw = await readFile(getCatalogMatchesPath(), 'utf8');
    const parsed = JSON.parse(raw) as CatalogProductMatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveCatalogMatches(matches: CatalogProductMatch[]): Promise<void> {
  await atomicWrite(getCatalogMatchesPath(), JSON.stringify(matches, null, 2));
}

async function loadJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function computeAutoMatches(opts: {
  manualProducts: CrmProduct[];
  manualOffers: CrmOffer[];
  crmProducts: CrmProduct[];
  crmOffers: CrmOffer[];
  preserveManual?: CatalogProductMatch[];
}): CatalogProductMatch[] {
  const now = new Date().toISOString();
  const preserved = new Map(
    (opts.preserveManual ?? [])
      .filter((m) => m.method === 'manual')
      .map((m) => [m.manualProductId, m]),
  );

  const offersByManual = new Map<number, CrmOffer[]>();
  for (const o of opts.manualOffers) {
    const arr = offersByManual.get(o.productId);
    if (arr) arr.push(o);
    else offersByManual.set(o.productId, [o]);
  }

  const crmBySku = new Map<string, number>();
  for (const o of opts.crmOffers) {
    const sku = normalizeSku(o.sku);
    if (!sku) continue;
    if (!crmBySku.has(sku)) crmBySku.set(sku, o.productId);
  }
  // Also index product-level if offers lack sku but product has none — skip.

  const liveCrm = opts.crmProducts.filter((p) => !p.isArchived);
  const usedCrm = new Set<number>();
  const result: CatalogProductMatch[] = [];

  for (const manual of opts.manualProducts) {
    const keep = preserved.get(manual.id);
    if (keep) {
      result.push({ ...keep, updatedAt: keep.updatedAt || now });
      usedCrm.add(keep.crmProductId);
      continue;
    }

    let method: CatalogMatchMethod | null = null;
    let confidence: CatalogMatchConfidence | null = null;
    let crmProductId: number | null = null;

    const manualOffers = offersByManual.get(manual.id) ?? [];
    for (const o of manualOffers) {
      const sku = normalizeSku(o.sku);
      if (!sku) continue;
      const hit = crmBySku.get(sku);
      if (hit != null && !usedCrm.has(hit)) {
        method = 'sku';
        confidence = 'high';
        crmProductId = hit;
        break;
      }
    }

    if (crmProductId == null) {
      let bestScore = 0;
      let bestId: number | null = null;
      for (const crm of liveCrm) {
        if (usedCrm.has(crm.id)) continue;
        const score = nameMatchScore(manual.name, crm.name);
        if (score > bestScore) {
          bestScore = score;
          bestId = crm.id;
        }
      }
      // Require strong overlap; avoid short-token false positives (score uses tokens ≥3).
      if (bestId != null && bestScore >= 0.72) {
        method = 'name';
        confidence = bestScore >= 0.92 ? 'high' : 'medium';
        crmProductId = bestId;
      }
    }

    if (method && confidence && crmProductId != null) {
      usedCrm.add(crmProductId);
      result.push({
        manualProductId: manual.id,
        crmProductId,
        method,
        confidence,
        updatedAt: now,
      });
    }
  }

  return result;
}

export async function rebuildCatalogMatches(): Promise<{
  matched: number;
  unmatchedManual: number;
  matches: CatalogProductMatch[];
}> {
  const [manualProducts, manualOffers, crmProducts, crmOffers, existing] =
    await Promise.all([
      loadJsonArray<CrmProduct>(getManualProductsPath()),
      loadJsonArray<CrmOffer>(getManualOffersPath()),
      loadJsonArray<CrmProduct>(resolve(DATA_DIR, 'products.json')),
      loadJsonArray<CrmOffer>(resolve(DATA_DIR, 'offers.json')),
      loadCatalogMatches(),
    ]);

  const matches = computeAutoMatches({
    manualProducts,
    manualOffers,
    crmProducts,
    crmOffers,
    preserveManual: existing,
  });

  await saveCatalogMatches(matches);
  log.info(
    {
      matched: matches.length,
      unmatchedManual: Math.max(0, manualProducts.length - matches.length),
    },
    'Catalog matches rebuilt',
  );

  return {
    matched: matches.length,
    unmatchedManual: Math.max(0, manualProducts.length - matches.length),
    matches,
  };
}

export async function upsertManualCatalogMatch(
  manualProductId: number,
  crmProductId: number,
): Promise<CatalogProductMatch[]> {
  const matches = await loadCatalogMatches();
  const next = matches.filter(
    (m) => m.manualProductId !== manualProductId && m.crmProductId !== crmProductId,
  );
  next.push({
    manualProductId,
    crmProductId,
    method: 'manual',
    confidence: 'high',
    updatedAt: new Date().toISOString(),
  });
  await saveCatalogMatches(next);
  return next;
}

export async function removeCatalogMatch(
  manualProductId: number,
): Promise<CatalogProductMatch[]> {
  const matches = (await loadCatalogMatches()).filter(
    (m) => m.manualProductId !== manualProductId,
  );
  await saveCatalogMatches(matches);
  return matches;
}

export async function getCatalogMatchOverview(): Promise<{
  matches: CatalogProductMatch[];
  matched: number;
  unmatchedManual: Array<{ id: number; name: string; minPrice: number | null; maxPrice: number | null }>;
  unmatchedCrmSample: Array<{ id: number; name: string; minPrice: number | null; maxPrice: number | null }>;
  crmProductOptions: Array<{ id: number; name: string; minPrice: number | null; maxPrice: number | null }>;
}> {
  const [matches, manualProducts, crmProducts] = await Promise.all([
    loadCatalogMatches(),
    loadJsonArray<CrmProduct>(getManualProductsPath()),
    loadJsonArray<CrmProduct>(resolve(DATA_DIR, 'products.json')),
  ]);
  const matchedManual = new Set(matches.map((m) => m.manualProductId));
  const matchedCrm = new Set(matches.map((m) => m.crmProductId));

  const unmatchedManual = manualProducts
    .filter((p) => !matchedManual.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      minPrice: p.minPrice,
      maxPrice: p.maxPrice,
    }));

  const unmatchedCrmSample = crmProducts
    .filter((p) => !p.isArchived && !matchedCrm.has(p.id))
    .slice(0, 200)
    .map((p) => ({
      id: p.id,
      name: p.name,
      minPrice: p.minPrice,
      maxPrice: p.maxPrice,
    }));

  const crmProductOptions = crmProducts
    .filter((p) => !p.isArchived)
    .slice(0, 500)
    .map((p) => ({
      id: p.id,
      name: p.name,
      minPrice: p.minPrice,
      maxPrice: p.maxPrice,
    }));

  return {
    matches,
    matched: matches.length,
    unmatchedManual,
    unmatchedCrmSample,
    crmProductOptions,
  };
}
