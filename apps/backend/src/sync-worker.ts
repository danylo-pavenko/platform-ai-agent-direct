/**
 * sync-worker.ts - Standalone KeyCRM sync entrypoint.
 *
 * PM2 name: {INSTANCE_ID}-sync (e.g. SB-sync).
 * Runs once, fetches KeyCRM data, generates catalog.txt, exits.
 *
 * Invariants:
 *   1. Only one run in flight at a time. `runSync()` refuses to start if a
 *      row with status='running' exists younger than STALE_RUN_MS; older
 *      ones are reaped as 'error' (the process was killed before finishing).
 *   2. Every file write is atomic (tmp → fsync → rename), so a half-written
 *      catalog.txt never reaches the bot.
 *   3. Every run row begins as 'running' and transitions exactly once — so
 *      the UI can truthfully distinguish in-flight / success / failure.
 */

import './config.js';

import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';

import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { REPO_ROOT, getCatalogPath } from './lib/paths.js';
import { getCrmAdapter } from './services/crm/index.js';
import type { CrmCategory, CrmProduct, CrmOffer } from './services/crm/index.js';

// ── Paths ──────────────────────────────────────────────────────────────────

const DATA_DIR = resolve(REPO_ROOT, 'data');
const CATALOG_PATH = getCatalogPath();

// ── Lock / retention tunables ──────────────────────────────────────────────

// A run older than this with status='running' is considered dead (process
// was killed mid-flight) and gets reaped to 'error' so the next trigger
// can proceed. Chosen to comfortably exceed the 95th percentile sync time.
const STALE_RUN_MS = 15 * 60 * 1_000;

// Keep at most this many historical rows. Older runs get pruned at the
// tail of every successful sync — cheap housekeeping, prevents unbounded
// growth of the keycrm_sync_runs table.
const RETENTION_ROWS = 100;

// ── Logger ─────────────────────────────────────────────────────────────────

const log = pino({
  name: `${config.INSTANCE_ID}-sync`,
  level: config.LOG_LEVEL,
});

// ── Sync concurrency guard ─────────────────────────────────────────────────

export class SyncInProgressError extends Error {
  constructor(public readonly startedAt: Date, public readonly runId: string) {
    super(`Sync already running since ${startedAt.toISOString()}`);
    this.name = 'SyncInProgressError';
  }
}

/**
 * Reap any sync row whose `status='running'` predates STALE_RUN_MS.
 * Such rows came from processes that were killed (OOM, SIGKILL, redeploy)
 * before they could flip to ok/error. We move them to 'error' so they
 * stop blocking new runs and show up honestly in the admin history.
 */
async function reapStaleRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUN_MS);
  const reaped = await prisma.keycrmSyncRun.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: cutoff },
      finishedAt: null,
    },
    data: {
      status: 'error',
      finishedAt: new Date(),
      errorMessage: 'Sync run reaped — process exited before completion',
    },
  });
  return reaped.count;
}

// ── Category mapping heuristic ─────────────────────────────────────────────

const NO_CAT = 'Без категорії';

/** Name-based heuristic: (substring, category). Order matters - first match wins. */
const NAME_HEURISTIC: Array<[string, string]> = [
  ['худі', 'Худі'],
  ['лонгслів', 'Лонги'],
  ['лонг оверсайз', 'Лонги'],
  ['лонг', 'Лонги'],
  ['світшот-зіп', 'Світшоти'],
  ['світшот', 'Світшоти'],
  ['зіпка', 'Зіпки'],
  ['футболк', 'Футболки'],
  ['сорочк', 'Сорочки'],
  ['кепк', 'Кепки'],
  ['шопер', 'Аксесуари'],
  ['закладк', 'Аксесуари'],
  ['пояс', 'Аксесуари'],
  ['box', 'Бокси'],
  ['бокс', 'Бокси'],
  ['упакуванн', 'Упакування'],
  ['індивідуальн', 'Індивідуальне нанесення'],
  ['принт', 'Індивідуальне нанесення'],
  ['вишивк', 'Індивідуальне нанесення'],
];

/** Display order for categories in catalog output. */
const DISPLAY_ORDER = [
  'Худі',
  'Світшоти',
  'Лонги',
  'Зіпки',
  'Футболки',
  'Сорочки',
  'Кепки',
  'Аксесуари',
  'Бокси',
  'Упакування',
  'Індивідуальне нанесення',
  NO_CAT,
];

// ── Helpers ────────────────────────────────────────────────────────────────

function categorizeProduct(product: CrmProduct): string {
  const name = (product.name ?? '').toLowerCase();
  for (const [key, label] of NAME_HEURISTIC) {
    if (name.includes(key)) {
      return label;
    }
  }
  return NO_CAT;
}

/**
 * Format a price number with space as thousands separator: 1234 → "1 234 ₴".
 */
function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '-';
  const n = Number(v);
  if (Number.isNaN(n)) return '-';
  if (Number.isInteger(n)) {
    return n.toLocaleString('uk-UA').replace(/ /g, ' ') + ' ₴';
  }
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2 }).replace(/ /g, ' ') + ' ₴';
}

function fmtPriceRange(lo: number | null | undefined, hi: number | null | undefined): string {
  if (lo == null && hi == null) return '-';
  if (lo === hi || hi == null) return fmtPrice(lo);
  if (lo == null) return fmtPrice(hi);
  return `${fmtPrice(lo)} – ${fmtPrice(hi)}`;
}

function variantLabel(properties: Array<{ name: string; value: string }> | undefined): string {
  if (!properties || properties.length === 0) return '(без варіанту)';
  const parts: string[] = [];
  for (const p of properties) {
    const name = (p.name ?? '').trim();
    const value = (p.value ?? '').trim();
    if (name && value) {
      parts.push(`${name}: ${value}`);
    } else if (value) {
      parts.push(value);
    }
  }
  return parts.join(' | ') || '(без варіанту)';
}

/**
 * Order categories: first by DISPLAY_ORDER, then alphabetically for any extra.
 */
function orderedCategories(groups: Map<string, CrmProduct[]>): string[] {
  const inOrder = DISPLAY_ORDER.filter((c) => groups.has(c));
  const extra = [...groups.keys()]
    .filter((c) => !DISPLAY_ORDER.includes(c))
    .sort();
  return [...inOrder, ...extra];
}

// ── Catalog builder ────────────────────────────────────────────────────────

/**
 * Check if a product is a "service" item (custom print/embroidery).
 * These have price 1₴ and should be listed separately.
 */
function isServiceItem(product: CrmProduct): boolean {
  const name = (product.name ?? '').toLowerCase();
  return (
    name.startsWith('принт ') ||
    name.startsWith('вишивка ') ||
    name === 'принт - сорочки' ||
    name.includes('принт l + blessed')
  );
}

/**
 * Check if a product has ANY variant in stock.
 */
function hasAnyStock(productId: number, offersByPid: Map<number, CrmOffer[]>): boolean {
  const po = offersByPid.get(productId) ?? [];
  return po.some((o) => (o.quantity ?? 0) > 0);
}

/**
 * Extract color from product name (e.g. "Худі, чорний" → "чорний").
 */
function extractColor(name: string): string | null {
  const match = name.match(/,\s*(.+)$/);
  return match ? match[1].trim().toLowerCase() : null;
}

function buildCatalog(
  products: CrmProduct[],
  offers: CrmOffer[],
  _categories: CrmCategory[],
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Filter: non-archived only
  const live = products.filter((p) => !p.isArchived);
  const liveIds = new Set(live.map((p) => p.id));

  // Group offers by product_id (only for live products)
  const offersByPid = new Map<number, CrmOffer[]>();
  for (const o of offers) {
    if (liveIds.has(o.productId)) {
      const arr = offersByPid.get(o.productId);
      if (arr) arr.push(o);
      else offersByPid.set(o.productId, [o]);
    }
  }

  // Separate real products from service items
  const realProducts = live.filter((p) => !isServiceItem(p));
  const serviceItems = live.filter((p) => isServiceItem(p));

  // Split into in-stock and out-of-stock
  const inStockProducts = realProducts.filter((p) => hasAnyStock(p.id, offersByPid));
  const oosProducts = realProducts.filter((p) => !hasAnyStock(p.id, offersByPid));

  // Group in-stock by category
  const groups = new Map<string, CrmProduct[]>();
  for (const p of inStockProducts) {
    const cat = categorizeProduct(p);
    const arr = groups.get(cat);
    if (arr) arr.push(p);
    else groups.set(cat, [p]);
  }

  const ordered = orderedCategories(groups);

  // Count in-stock variants
  const totalInStockVariants = inStockProducts.reduce((sum, p) => {
    const po = offersByPid.get(p.id) ?? [];
    return sum + po.filter((o) => (o.quantity ?? 0) > 0).length;
  }, 0);

  const lines: string[] = [];

  // ── Header ──
  lines.push(`КАТАЛОГ ТОВАРІВ - ${config.BRAND_NAME.toUpperCase()}`);
  lines.push('='.repeat(50));
  lines.push(`Знімок з KeyCRM: ${now}`);
  lines.push(`Товарів у наявності: ${inStockProducts.length}, Варіантів у наявності: ${totalInStockVariants}`);
  lines.push('');

  // ── In-stock products by category ──
  for (const cat of ordered) {
    const items = groups.get(cat);
    if (!items || items.length === 0) continue;

    lines.push('='.repeat(60));
    lines.push(`КАТЕГОРІЯ: ${cat}`);
    lines.push('='.repeat(60));
    lines.push('');

    const sorted = [...items].sort((a, b) =>
      (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase(), 'uk'),
    );

    for (const p of sorted) {
      const name = (p.name ?? '').trim() || `#${p.id}`;
      const po = offersByPid.get(p.id) ?? [];
      const inStockOffers = po.filter((o) => (o.quantity ?? 0) > 0);
      const price = fmtPriceRange(p.minPrice, p.maxPrice);

      lines.push(`### ${name} - ${price}`);

      // Only show in-stock variants (skip out-of-stock clutter)
      if (inStockOffers.length > 0) {
        const sortedOffers = [...inStockOffers].sort((a, b) =>
          variantLabel(a.properties).localeCompare(variantLabel(b.properties), 'uk'),
        );
        for (const o of sortedOffers) {
          const label = variantLabel(o.properties);
          const qty = Number(o.quantity ?? 0);
          const stock = qty <= 3 ? `мало (${qty} шт)` : 'є';
          lines.push(`  - ${label} - ${fmtPrice(o.price)} - ${stock}`);
        }
      }

      // Note which variants are OUT of stock
      const oosOffers = po.filter((o) => (o.quantity ?? 0) <= 0);
      if (oosOffers.length > 0) {
        const oosLabels = oosOffers.map((o) => variantLabel(o.properties));
        lines.push(`  [немає в наявності: ${oosLabels.join(', ')}]`);
      }
      lines.push('');
    }
  }

  // ── Out-of-stock products (short list for alternatives) ──
  if (oosProducts.length > 0) {
    lines.push('='.repeat(60));
    lines.push('ТОВАРИ, ЯКИХ ЗАРАЗ НЕМАЄ В НАЯВНОСТІ');
    lines.push('(не пропонуй їх, але якщо клієнт запитає - скажи що немає і запропонуй альтернативу)');
    lines.push('='.repeat(60));
    lines.push('');

    for (const p of oosProducts) {
      const name = (p.name ?? '').trim();
      const cat = categorizeProduct(p);
      const color = extractColor(name);
      const altHint = color
        ? `→ запропонуй інший колір ${cat.toLowerCase()}`
        : `→ запропонуй інший ${cat.toLowerCase()}`;
      lines.push(`  - ${name} - НЕМАЄ. ${altHint}`);
    }
    lines.push('');
  }

  // ── Service items ──
  if (serviceItems.length > 0) {
    lines.push('='.repeat(60));
    lines.push('ІНДИВІДУАЛЬНЕ НАНЕСЕННЯ (сервісні позиції)');
    lines.push('='.repeat(60));
    lines.push('Це НЕ окремі товари, а опції кастомізації. Ціна 1 ₴ - службова, НЕ квотуй клієнту.');
    lines.push('Реальна вартість: принт 400–600 ₴, вишивка 1 000–1 500 ₴ (залежить від дизайну).');
    lines.push('Для замовлення кастомного нанесення - передай менеджеру.');
    lines.push('');
    lines.push('Доступні дизайни нанесення:');
    for (const p of serviceItems) {
      const po = offersByPid.get(p.id) ?? [];
      const designs = po
        .filter((o) => (o.quantity ?? 0) > 0)
        .map((o) => variantLabel(o.properties))
        .filter((l) => l !== '(без варіанту)');
      if (designs.length > 0) {
        lines.push(`  ${(p.name ?? '').trim()}: ${designs.join(', ')}`);
      }
    }
    lines.push('');
  }

  // ── Bot instructions ──
  lines.push('='.repeat(60));
  lines.push('ІНСТРУКЦІЇ ДЛЯ БОТА');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('ПРАВИЛА НАЯВНОСТІ:');
  lines.push('- Пропонуй ТІЛЬКИ товари зі списку "В НАЯВНОСТІ" вище.');
  lines.push('- Якщо варіант позначений "мало" - попередь клієнта: "Цього розміру залишилось небагато."');
  lines.push('- Якщо варіант у списку [немає в наявності] - НЕ пропонуй його. Скажи що немає і запропонуй:');
  lines.push('  а) інший колір того ж типу одягу (якщо є в наявності);');
  lines.push('  б) схожий тип одягу (наприклад світшот замість худі);');
  lines.push('  в) передати менеджеру для уточнення термінів поповнення.');
  lines.push('- Товари з розділу "НЕМАЄ В НАЯВНОСТІ" - згадуй тільки якщо клієнт прямо запитав про них.');
  lines.push('');
  lines.push('РОЗМІРИ:');
  lines.push('- Розмірна сітка парна: XS/S, M/L, XL/2XL (або XS, S/M, L/XL).');
  lines.push('- Якщо клієнт каже "M" - це варіант M/L або S/M (дивись що є для конкретного товару).');
  lines.push('- Для точної розмірної сітки конкретної моделі - передай менеджеру.');
  lines.push('');
  lines.push('ЦІНИ:');
  lines.push('- Не показуй точну кількість у штуках (крім "мало"). Кажи "є в наявності" або "залишилось небагато".');
  lines.push('- Ціни 1 ₴ - СЛУЖБОВІ (нанесення). Реальна вартість: принт 400–600 ₴, вишивка 1 000–1 500 ₴.');
  lines.push('- Для самовивозу з магазину (Львів) - уточнюй у менеджера наявність саме в магазині.');

  return lines.join('\n') + '\n';
}

// ── File IO helpers ────────────────────────────────────────────────────────

/**
 * Write `content` to `path` atomically. Writes to a sibling `.tmp` file
 * first and then renames — `rename(2)` is atomic on POSIX within the same
 * filesystem, so a reader will see either the old bytes or the complete
 * new bytes, never a half-written file.
 *
 * The tmp file is cleaned up on any failure so a crashed run doesn't leave
 * stray `.tmp.<pid>` debris in the tenant knowledge dir.
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Compose a useful errorMessage from any thrown value. Pulls `.cause`
 * (often the HTTP error from the CRM adapter) so the admin history
 * isn't stuck on bland wrapper messages.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    // Walk one level of cause — usually enough for adapter → HTTP client.
    if (cause instanceof Error) {
      parts.push(`caused by: ${cause.message}`);
    } else if (typeof cause === 'string') {
      parts.push(`caused by: ${cause}`);
    }
    return parts.join(' · ').slice(0, 2000);
  }
  return String(err).slice(0, 2000);
}

// ── Main (exported for use by routes/sync.ts) ─────────────────────────────

export async function runSync(): Promise<void> {
  log.info('KeyCRM sync started');

  // Reap dead locks before checking for live ones.
  const reaped = await reapStaleRuns();
  if (reaped > 0) {
    log.warn({ reaped }, 'Reaped stale sync runs left over from killed processes');
  }

  // Concurrency guard — only one 'running' row allowed. If one is alive
  // and young, bail fast so the caller (cron tick or admin click) can
  // show a useful 409 instead of queueing a duplicate.
  const inFlight = await prisma.keycrmSyncRun.findFirst({
    where: { status: 'running', finishedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (inFlight) {
    log.warn(
      { runId: inFlight.id, startedAt: inFlight.startedAt },
      'Another sync is already in flight — aborting this trigger',
    );
    throw new SyncInProgressError(inFlight.startedAt, inFlight.id);
  }

  // Create the run row up-front as 'running' — this IS the distributed
  // lock. Any other trigger hitting runSync() will see it via the check
  // above and back off.
  const syncRun = await prisma.keycrmSyncRun.create({
    data: { status: 'running' },
  });

  try {
    // Fetch all data from the active CRM provider
    const crm = getCrmAdapter();
    log.info({ provider: crm.name }, 'Fetching data from CRM...');
    const [categories, products, offers] = await Promise.all([
      crm.fetchCategories(),
      crm.fetchProducts(),
      crm.fetchOffers(),
    ]);

    log.info(
      { categories: categories.length, products: products.length, offers: offers.length },
      'Data fetched from KeyCRM',
    );

    // Save raw JSON and generated catalog atomically — if the process
    // dies mid-write, readers see the previous-good snapshot, never a
    // half-serialised file.
    await Promise.all([
      atomicWrite(resolve(DATA_DIR, 'categories.json'), JSON.stringify(categories, null, 2)),
      atomicWrite(resolve(DATA_DIR, 'products.json'), JSON.stringify(products, null, 2)),
      atomicWrite(resolve(DATA_DIR, 'offers.json'), JSON.stringify(offers, null, 2)),
    ]);
    log.info({ dir: DATA_DIR }, 'Raw JSON saved');

    const catalogText = buildCatalog(products, offers, categories);
    await atomicWrite(CATALOG_PATH, catalogText);
    log.info({ path: CATALOG_PATH, chars: catalogText.length }, 'Catalog generated');

    await prisma.keycrmSyncRun.update({
      where: { id: syncRun.id },
      data: {
        finishedAt: new Date(),
        status: 'ok',
        counts: {
          categories: categories.length,
          products: products.length,
          offers: offers.length,
        },
      },
    });

    // Retention: keep the last RETENTION_ROWS rows, drop the rest. Cheap
    // idempotent housekeeping — a single indexed query, safe to re-run.
    const keepIds = await prisma.keycrmSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: RETENTION_ROWS,
      select: { id: true },
    });
    if (keepIds.length === RETENTION_ROWS) {
      const { count } = await prisma.keycrmSyncRun.deleteMany({
        where: { id: { notIn: keepIds.map((r) => r.id) } },
      });
      if (count > 0) log.info({ pruned: count }, 'Pruned old sync history');
    }

    log.info('KeyCRM sync completed successfully');
  } catch (err) {
    log.error({ err }, 'KeyCRM sync failed');
    await prisma.keycrmSyncRun.update({
      where: { id: syncRun.id },
      data: {
        finishedAt: new Date(),
        status: 'error',
        errorMessage: formatError(err),
      },
    });
  }
}

// ── Standalone entrypoint (PM2: {INSTANCE_ID}-sync) ────────────────────────
// Detect "this file was invoked directly" in an ESM-safe way. Comparing
// `import.meta.url` to the URL of process.argv[1] is the canonical idiom
// and survives absolute paths, symlinks, and both .ts/.js builds.

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  runSync()
    .catch((err) => {
      // SyncInProgressError is not fatal — another instance is handling it.
      if (err instanceof SyncInProgressError) {
        log.warn({ err: err.message }, 'Skipped — concurrent run in progress');
        return;
      }
      log.fatal({ err }, 'Unhandled error in sync worker');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
