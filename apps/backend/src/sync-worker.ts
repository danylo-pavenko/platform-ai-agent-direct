/**
 * sync-worker.ts - Standalone KeyCRM sync entrypoint.
 *
 * PM2 name: {INSTANCE_ID}-sync (e.g. SB-sync).
 * Runs once, fetches KeyCRM data, generates catalog.txt, exits.
 */

import './config.js';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pino from 'pino';

import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { REPO_ROOT, getCatalogPath } from './lib/paths.js';
import {
  fetchCategories,
  fetchProducts,
  fetchOffers,
  type KeycrmCategory,
  type KeycrmProduct,
  type KeycrmOffer,
} from './services/keycrm.js';

// ── Paths ──────────────────────────────────────────────────────────────────

const DATA_DIR = resolve(REPO_ROOT, 'data');
const CATALOG_PATH = getCatalogPath();

// ── Logger ─────────────────────────────────────────────────────────────────

const log = pino({
  name: `${config.INSTANCE_ID}-sync`,
  level: config.LOG_LEVEL,
});

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

function categorizeProduct(product: KeycrmProduct): string {
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
    return n.toLocaleString('uk-UA').replace(/\u00a0/g, ' ') + ' ₴';
  }
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2 }).replace(/\u00a0/g, ' ') + ' ₴';
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
function orderedCategories(groups: Map<string, KeycrmProduct[]>): string[] {
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
function isServiceItem(product: KeycrmProduct): boolean {
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
function hasAnyStock(productId: number, offersByPid: Map<number, KeycrmOffer[]>): boolean {
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
  products: KeycrmProduct[],
  offers: KeycrmOffer[],
  _categories: KeycrmCategory[],
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Filter: non-archived only
  const live = products.filter((p) => !p.is_archived);
  const liveIds = new Set(live.map((p) => p.id));

  // Group offers by product_id (only for live products)
  const offersByPid = new Map<number, KeycrmOffer[]>();
  for (const o of offers) {
    if (liveIds.has(o.product_id)) {
      const arr = offersByPid.get(o.product_id);
      if (arr) arr.push(o);
      else offersByPid.set(o.product_id, [o]);
    }
  }

  // Separate real products from service items
  const realProducts = live.filter((p) => !isServiceItem(p));
  const serviceItems = live.filter((p) => isServiceItem(p));

  // Split into in-stock and out-of-stock
  const inStockProducts = realProducts.filter((p) => hasAnyStock(p.id, offersByPid));
  const oosProducts = realProducts.filter((p) => !hasAnyStock(p.id, offersByPid));

  // Group in-stock by category
  const groups = new Map<string, KeycrmProduct[]>();
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
      const price = fmtPriceRange(p.min_price, p.max_price);

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

// ── Main (exported for use by routes/sync.ts) ─────────────────────────────

export async function runSync(): Promise<void> {
  log.info('KeyCRM sync started');

  // Create sync run record
  const syncRun = await prisma.keycrmSyncRun.create({
    data: { status: 'ok' },
  });

  try {
    // Fetch all data from KeyCRM
    log.info('Fetching data from KeyCRM...');
    const [categories, products, offers] = await Promise.all([
      fetchCategories(),
      fetchProducts(),
      fetchOffers(),
    ]);

    log.info(
      { categories: categories.length, products: products.length, offers: offers.length },
      'Data fetched from KeyCRM',
    );

    // Save raw JSON to data/ directory
    await mkdir(DATA_DIR, { recursive: true });
    await Promise.all([
      writeFile(resolve(DATA_DIR, 'categories.json'), JSON.stringify(categories, null, 2), 'utf-8'),
      writeFile(resolve(DATA_DIR, 'products.json'), JSON.stringify(products, null, 2), 'utf-8'),
      writeFile(resolve(DATA_DIR, 'offers.json'), JSON.stringify(offers, null, 2), 'utf-8'),
    ]);
    log.info({ dir: DATA_DIR }, 'Raw JSON saved');

    // Generate catalog.txt
    const catalogText = buildCatalog(products, offers, categories);
    await mkdir(dirname(CATALOG_PATH), { recursive: true });
    await writeFile(CATALOG_PATH, catalogText, 'utf-8');
    log.info({ path: CATALOG_PATH, chars: catalogText.length }, 'Catalog generated');

    // Update sync run - success
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

    log.info('KeyCRM sync completed successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'KeyCRM sync failed');

    // Update sync run - error
    await prisma.keycrmSyncRun.update({
      where: { id: syncRun.id },
      data: {
        finishedAt: new Date(),
        status: 'error',
        errorMessage: message.slice(0, 2000),
      },
    });
  }
}

// ── Standalone entrypoint (PM2: SB-sync) ──────────────────────────────────
// When run directly, execute sync and exit.

const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('sync-worker.ts') || process.argv[1].endsWith('sync-worker.js'));

if (isMainModule) {
  runSync()
    .catch((err) => {
      log.fatal({ err }, 'Unhandled error in sync worker');
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
