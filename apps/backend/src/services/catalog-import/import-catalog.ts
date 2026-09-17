/**
 * Manual catalog import: draft sessions, commit to data/manual-*.json + catalog-manual.txt.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import { prisma, toInputJsonValue } from '../../lib/prisma.js';
import {
  getManualCatalogPath,
  getManualCategoriesPath,
  getManualOffersPath,
  getManualProductsPath,
  getCatalogMatchesPath,
  REPO_ROOT,
} from '../../lib/paths.js';
import { invalidateCatalogIndexCache } from '../../lib/catalog-index.js';
import type { CrmCategory, CrmOffer, CrmProduct } from '../crm/types.js';
import { parseCatalogCsv } from './parsers/index.js';
import {
  CATALOG_IMPORT_SETTING_KEY,
  DEFAULT_CATALOG_IMPORT_SETTINGS,
  type CatalogImportDraft,
  type CatalogImportSettings,
  type CatalogImportSource,
  type CatalogPricePreference,
  type CatalogSourcePriority,
  type CatalogVerifyResult,
} from './types.js';
import { verifyCatalogImportDraft } from './verify-catalog.js';

const log = pino({ name: 'catalog-import' });

const DRAFT_TTL_MS = 60 * 60 * 1000;
const MAX_CSV_BYTES = 50 * 1024 * 1024;

const DRAFT_DIR = resolve(REPO_ROOT, 'data', 'catalog-import-drafts');

export interface CatalogImportSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  draft: CatalogImportDraft;
  verify: CatalogVerifyResult;
}

function draftPath(id: string): string {
  return resolve(DRAFT_DIR, `${id}.json`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

function buildManualCatalogText(draft: CatalogImportDraft): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const offersByPid = new Map<number, CrmOffer[]>();
  for (const o of draft.offers) {
    const arr = offersByPid.get(o.productId);
    if (arr) arr.push(o);
    else offersByPid.set(o.productId, [o]);
  }

  const live = draft.products.filter((p) => !p.isArchived);
  const lines: string[] = [
    `КАТАЛОГ ТОВАРІВ (файл · ${draft.source})`,
    '='.repeat(50),
    `Імпорт: ${now}`,
    `Товарів: ${live.length}, Варіантів: ${draft.stats.availableOffers}`,
    '',
  ];

  const byCat = new Map<string, CrmProduct[]>();
  const catName = new Map(draft.categories.map((c) => [c.id, c.name]));
  for (const p of live) {
    const cat = (p.categoryId != null ? catName.get(p.categoryId) : null) || 'Інше';
    const arr = byCat.get(cat);
    if (arr) arr.push(p);
    else byCat.set(cat, [p]);
  }

  for (const [cat, items] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0], 'uk'))) {
    lines.push('='.repeat(60));
    lines.push(`КАТЕГОРІЯ: ${cat}`);
    lines.push('='.repeat(60));
    lines.push('');
    for (const p of [...items].sort((a, b) => a.name.localeCompare(b.name, 'uk'))) {
      const price =
        p.minPrice != null && p.maxPrice != null && p.minPrice !== p.maxPrice
          ? `${p.minPrice}–${p.maxPrice}₴`
          : p.minPrice != null
            ? `${p.minPrice}₴`
            : 'ціна уточнюється';
      lines.push(`### ${p.name} - ${price}`);
      const offers = (offersByPid.get(p.id) ?? []).filter((o) => !o.isArchived);
      for (const o of offers.slice(0, 40)) {
        const variant = o.properties.map((x) => `${x.name}: ${x.value}`).join(', ') || '—';
        lines.push(`  - ${variant} | ${o.price}₴ | ${o.quantity} шт${o.sku ? ` | ${o.sku}` : ''}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export async function getCatalogImportSettings(): Promise<CatalogImportSettings> {
  const row = await prisma.setting.findUnique({ where: { key: CATALOG_IMPORT_SETTING_KEY } });
  const raw = (row?.value ?? {}) as Partial<CatalogImportSettings>;
  const sourcePriority =
    raw.sourcePriority === 'crm' || raw.sourcePriority === 'file'
      ? raw.sourcePriority
      : DEFAULT_CATALOG_IMPORT_SETTINGS.sourcePriority;
  const pricePreference =
    raw.pricePreference === 'crm' || raw.pricePreference === 'file'
      ? raw.pricePreference
      : sourcePriority;
  return {
    ...DEFAULT_CATALOG_IMPORT_SETTINGS,
    ...raw,
    sourcePriority,
    pricePreference,
  };
}

export async function saveCatalogImportSettings(
  patch: Partial<CatalogImportSettings>,
): Promise<CatalogImportSettings> {
  const current = await getCatalogImportSettings();
  const next: CatalogImportSettings = { ...current, ...patch };
  await prisma.setting.upsert({
    where: { key: CATALOG_IMPORT_SETTING_KEY },
    create: {
      key: CATALOG_IMPORT_SETTING_KEY,
      value: toInputJsonValue(next)!,
    },
    update: { value: toInputJsonValue(next)! },
  });
  return next;
}

export async function startCatalogImport(opts: {
  source: CatalogImportSource;
  csvText: string;
  skipVerify?: boolean;
}): Promise<CatalogImportSession> {
  const bytes = Buffer.byteLength(opts.csvText, 'utf8');
  if (bytes > MAX_CSV_BYTES) {
    throw new CatalogImportError(`Файл завеликий (макс. ${MAX_CSV_BYTES / (1024 * 1024)} МБ)`, 413);
  }
  if (!opts.csvText.trim()) {
    throw new CatalogImportError('Порожній CSV', 400);
  }

  const draft = parseCatalogCsv(opts.source, opts.csvText);
  const verify = opts.skipVerify
    ? {
        ok: true,
        confidence: 1,
        issues: [] as CatalogVerifyResult['issues'],
        summaryUk: 'Перевірку пропущено (тест).',
      }
    : await verifyCatalogImportDraft(draft);

  const id = randomUUID();
  const createdAt = new Date();
  const session: CatalogImportSession = {
    id,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + DRAFT_TTL_MS).toISOString(),
    draft,
    verify,
  };

  await mkdir(DRAFT_DIR, { recursive: true });
  await atomicWrite(draftPath(id), JSON.stringify(session));
  log.info(
    {
      sessionId: id,
      source: opts.source,
      products: draft.stats.productCount,
      offers: draft.stats.offerCount,
      verifyOk: verify.ok,
    },
    'Catalog import draft ready',
  );
  return session;
}

export async function loadCatalogImportSession(
  id: string,
): Promise<CatalogImportSession | null> {
  try {
    const raw = await readFile(draftPath(id), 'utf8');
    const session = JSON.parse(raw) as CatalogImportSession;
    if (Date.parse(session.expiresAt) < Date.now()) {
      await unlink(draftPath(id)).catch(() => undefined);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export async function confirmCatalogImport(
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{
  productCount: number;
  offerCount: number;
  settings: CatalogImportSettings;
}> {
  const session = await loadCatalogImportSession(sessionId);
  if (!session) {
    throw new CatalogImportError('Сесія імпорту не знайдена або протермінована', 404);
  }
  if (!session.verify.ok && !opts?.force) {
    throw new CatalogImportError(
      'Claude verify знайшов критичні проблеми. Виправте CSV або підтвердіть з force=true',
      400,
    );
  }

  const { draft, verify } = session;
  await atomicWrite(getManualProductsPath(), JSON.stringify(draft.products, null, 2));
  await atomicWrite(getManualOffersPath(), JSON.stringify(draft.offers, null, 2));
  await atomicWrite(getManualCategoriesPath(), JSON.stringify(draft.categories, null, 2));
  await atomicWrite(getManualCatalogPath(), buildManualCatalogText(draft));

  invalidateCatalogIndexCache();
  await unlink(draftPath(sessionId)).catch(() => undefined);

  try {
    const { rebuildCatalogMatches } = await import('./catalog-match.js');
    await rebuildCatalogMatches();
  } catch (err) {
    log.warn({ err }, 'Catalog match rebuild after import failed (non-fatal)');
  }

  const settings = await saveCatalogImportSettings({
    lastImportAt: new Date().toISOString(),
    lastSource: draft.source,
    productCount: draft.stats.productCount,
    offerCount: draft.stats.offerCount,
    verifyStatus: verify.ok
      ? verify.issues.some((i) => i.severity === 'warning')
        ? 'warnings'
        : 'ok'
      : 'failed',
    verifySummary: verify.summaryUk,
    // Keep existing priority; default file if first import
  });

  log.info(
    { sessionId, products: draft.stats.productCount, offers: draft.stats.offerCount },
    'Manual catalog committed',
  );

  return {
    productCount: draft.stats.productCount,
    offerCount: draft.stats.offerCount,
    settings,
  };
}

export async function clearManualCatalog(): Promise<void> {
  for (const path of [
    getManualProductsPath(),
    getManualOffersPath(),
    getManualCategoriesPath(),
    getManualCatalogPath(),
    getCatalogMatchesPath(),
  ]) {
    await unlink(path).catch(() => undefined);
  }
  invalidateCatalogIndexCache();
  await saveCatalogImportSettings({
    lastImportAt: null,
    lastSource: null,
    productCount: 0,
    offerCount: 0,
    verifyStatus: 'none',
    verifySummary: null,
  });
}

export async function loadManualCatalogFiles(): Promise<{
  products: CrmProduct[];
  offers: CrmOffer[];
  categories: CrmCategory[];
} | null> {
  try {
    const [productsRaw, offersRaw, categoriesRaw] = await Promise.all([
      readFile(getManualProductsPath(), 'utf8'),
      readFile(getManualOffersPath(), 'utf8'),
      readFile(getManualCategoriesPath(), 'utf8').catch(() => '[]'),
    ]);
    return {
      products: JSON.parse(productsRaw) as CrmProduct[],
      offers: JSON.parse(offersRaw) as CrmOffer[],
      categories: JSON.parse(categoriesRaw) as CrmCategory[],
    };
  } catch {
    return null;
  }
}

export async function setCatalogSourcePriority(
  priority: CatalogSourcePriority,
): Promise<CatalogImportSettings> {
  return saveCatalogImportSettings({ sourcePriority: priority });
}

export async function setCatalogPricePreference(
  preference: CatalogPricePreference,
): Promise<CatalogImportSettings> {
  return saveCatalogImportSettings({ pricePreference: preference });
}

export class CatalogImportError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'CatalogImportError';
    this.statusCode = statusCode;
  }
}

export { MAX_CSV_BYTES };
