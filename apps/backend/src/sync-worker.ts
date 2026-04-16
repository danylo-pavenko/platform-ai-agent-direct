/**
 * sync-worker.ts — Standalone KeyCRM sync entrypoint.
 *
 * PM2 name: {INSTANCE_ID}-sync (e.g. SB-sync).
 * Runs once, fetches KeyCRM data, generates catalog.txt, exits.
 */

import './config.js';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import {
  fetchCategories,
  fetchProducts,
  fetchOffers,
  type KeycrmCategory,
  type KeycrmProduct,
  type KeycrmOffer,
} from './services/keycrm.js';

// ── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');
const CATALOG_PATH = resolve(PROJECT_ROOT, 'apps', 'workspace', 'knowledge', 'catalog.txt');

// ── Logger ─────────────────────────────────────────────────────────────────

const log = pino({
  name: `${config.INSTANCE_ID}-sync`,
  level: config.LOG_LEVEL,
});

// ── Category mapping heuristic ─────────────────────────────────────────────

const NO_CAT = 'Без категорії';

/** Name-based heuristic: (substring, category). Order matters — first match wins. */
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
  if (v == null) return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  if (Number.isInteger(n)) {
    return n.toLocaleString('uk-UA').replace(/\u00a0/g, ' ') + ' ₴';
  }
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2 }).replace(/\u00a0/g, ' ') + ' ₴';
}

function fmtPriceRange(lo: number | null | undefined, hi: number | null | undefined): string {
  if (lo == null && hi == null) return '—';
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

function buildCatalog(
  products: KeycrmProduct[],
  offers: KeycrmOffer[],
  categories: KeycrmCategory[],
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Filter: only non-archived products
  const live = products.filter((p) => !p.is_archived);
  const liveIds = new Set(live.map((p) => p.id));

  // Group offers by product_id
  const offersByPid = new Map<number, KeycrmOffer[]>();
  for (const o of offers) {
    if (liveIds.has(o.product_id)) {
      const existing = offersByPid.get(o.product_id);
      if (existing) {
        existing.push(o);
      } else {
        offersByPid.set(o.product_id, [o]);
      }
    }
  }

  // Group products by display category
  const groups = new Map<string, KeycrmProduct[]>();
  for (const p of live) {
    const cat = categorizeProduct(p);
    const existing = groups.get(cat);
    if (existing) {
      existing.push(p);
    } else {
      groups.set(cat, [p]);
    }
  }

  const ordered = orderedCategories(groups);

  // Count total variants across live products
  const totalVariants = live.reduce(
    (sum, p) => sum + (offersByPid.get(p.id)?.length ?? 0),
    0,
  );

  const lines: string[] = [];

  // Header
  lines.push(`КАТАЛОГ ТОВАРІВ — ${config.BRAND_NAME.toUpperCase()}`);
  lines.push('='.repeat(50));
  lines.push(`Знімок з KeyCRM: ${now}`);
  lines.push(`Товарів: ${live.length}, Варіантів: ${totalVariants}`);
  lines.push('');

  // Per-category blocks
  for (const cat of ordered) {
    const items = groups.get(cat);
    if (!items || items.length === 0) continue;

    lines.push('='.repeat(70));
    lines.push(`КАТЕГОРІЯ: ${cat}`);
    lines.push('='.repeat(70));
    lines.push('');

    // Sort products alphabetically within category
    const sorted = [...items].sort((a, b) =>
      (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase(), 'uk'),
    );

    for (const p of sorted) {
      const name = (p.name ?? '').trim() || `#${p.id}`;
      const price = fmtPriceRange(p.min_price, p.max_price);
      const po = offersByPid.get(p.id) ?? [];
      const inStock = po.filter((o) => (o.quantity ?? 0) > 0).length;
      const totalV = po.length;

      lines.push(`### ${name} — ${price}`);
      if (p.description && p.description.trim()) {
        lines.push(`  Опис: ${p.description.trim()}`);
      }
      lines.push(`  Варіанти: ${totalV} всього, ${inStock} в наявності`);

      if (po.length > 0) {
        // Sort variants by label for readability
        const sortedOffers = [...po].sort((a, b) =>
          variantLabel(a.properties).localeCompare(variantLabel(b.properties), 'uk'),
        );
        for (const o of sortedOffers) {
          const label = variantLabel(o.properties);
          const qty = Number(o.quantity ?? 0);
          let stock: string;
          if (qty > 0) {
            stock = `в наявності: ${qty}`;
          } else if (qty === 0) {
            stock = 'немає в наявності';
          } else {
            stock = `немає (облік: ${qty})`;
          }
          const oPrice = fmtPrice(o.price);
          lines.push(`  - ${label} — ${oPrice} — ${stock}`);
        }
      }
      lines.push('');
    }
  }

  // Footer notes
  lines.push('='.repeat(70));
  lines.push('ПРИМІТКИ ДЛЯ БОТА');
  lines.push('='.repeat(70));
  lines.push(
    '1. Розмірна сітка парна: XS/S, M/L, XL/2XL. Один варіант покриває ' +
    'два суміжні розміри. Якщо клієнт питає чистий \'M\' — це M/L.',
  );
  lines.push(
    '2. Категорія "Індивідуальне нанесення" — ціни 1 ₴ службові. ' +
    'Реальна вартість: принт 400–600 ₴, вишивка 1000–1500 ₴. ' +
    'НЕ квотуй клієнту ціну 1 ₴.',
  );
  lines.push(
    '3. Якщо quantity = 0 або від\'ємне — НЕ обіцяй клієнту наявність, ' +
    'ескалюй до менеджера або запропонуй альтернативу.',
  );
  lines.push(
    '4. Значення quantity — це KeyCRM-залишок на всіх складах сумарно. ' +
    'Для самовивозу завжди переадресовуй до менеджера.',
  );

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

    // Update sync run — success
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

    // Update sync run — error
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
