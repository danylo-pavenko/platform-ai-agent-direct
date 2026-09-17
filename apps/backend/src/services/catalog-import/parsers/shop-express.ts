/**
 * Deterministic Shop-Express (Engine) CSV → CrmProduct / CrmOffer.
 *
 * Export quirks: UTF-8 BOM, `;` delimiter, quoted fields, prices like `1100,0000`.
 * Each row is a SKU/modification with unique ID; we group by Name+Categories into products.
 */

import type { CrmCategory, CrmOffer, CrmProduct } from '../../crm/types.js';
import type {
  CatalogImportDraft,
  CatalogImportSampleRow,
  CatalogImportStats,
} from '../types.js';

const ATTR_COLUMNS = ['Колір', 'Розмір', 'Дизайн', 'Стать'] as const;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Minimal RFC4180-ish CSV parse for `;` + quotes (handles "" escapes). */
export function parseDelimitedCsv(text: string, delimiter = ';'): string[][] {
  const input = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function parseShopExpressPrice(raw: string): number {
  const cleaned = raw.trim().replace(/\s+/g, '').replace(',', '.');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function sanitizeText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerIndex(headers: string[], name: string): number {
  const lower = name.toLowerCase();
  return headers.findIndex((h) => h.trim().replace(/^"|"$/g, '').toLowerCase() === lower);
}

function cell(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return '';
  return (row[idx] ?? '').trim();
}

function parseProperties(
  headers: string[],
  row: string[],
  modificationName: string,
): Array<{ name: string; value: string }> {
  const props: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();

  for (const col of ATTR_COLUMNS) {
    const idxs = headers
      .map((h, i) => (h.trim() === col ? i : -1))
      .filter((i) => i >= 0);
    for (const idx of idxs) {
      const value = sanitizeText(cell(row, idx));
      if (!value) continue;
      const key = `${col}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      props.push({ name: col, value });
      break;
    }
  }

  if (props.length === 0 && modificationName) {
    // "Чорний, XS/S" → try split
    const parts = modificationName.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      props.push({ name: 'Колір', value: parts[0]! });
      props.push({ name: 'Розмір', value: parts.slice(1).join(', ') });
    } else if (parts.length === 1) {
      props.push({ name: 'Варіант', value: parts[0]! });
    }
  }

  return props;
}

export function parseShopExpressCsv(csvText: string): CatalogImportDraft {
  const matrix = parseDelimitedCsv(csvText, ';');
  if (matrix.length < 2) {
    throw new Error('CSV порожній або без рядків даних');
  }

  const headers = (matrix[0] ?? []).map((h) => h.trim().replace(/^"|"$/g, ''));
  const idIdx = headerIndex(headers, 'ID');
  const nameIdx = headerIndex(headers, 'Name');
  const priceIdx = headerIndex(headers, 'Price');
  const actionPriceIdx = headerIndex(headers, 'ActionPrice');
  const skuIdx = headerIndex(headers, 'Sku');
  const currencyIdx = headerIndex(headers, 'Currency');
  const categoriesIdx = headerIndex(headers, 'Categories');
  const imagesIdx = headerIndex(headers, 'Images');
  const barcodeIdx = headerIndex(headers, 'Barcode');
  const inStockIdx = headerIndex(headers, 'InStock');
  const isAvailableIdx = headerIndex(headers, 'IsAvailable');
  const modIdx = headerIndex(headers, 'ProductModificationName');
  const shortDescIdx = headerIndex(headers, 'ShortDescription');
  const nameDescIdx = headerIndex(headers, 'NameDescription');

  if (idIdx < 0 || nameIdx < 0 || priceIdx < 0) {
    throw new Error(
      'Не схоже на експорт Shop-Express: потрібні колонки ID, Name, Price',
    );
  }

  const warnings: string[] = [];
  const now = new Date().toISOString();

  type Acc = {
    name: string;
    categoryName: string;
    description: string | null;
    thumbnailUrl: string | null;
    currencyCode: string;
    offers: CrmOffer[];
    rowIds: number[];
  };

  const groups = new Map<string, Acc>();
  const categoryNames = new Map<string, number>();
  let nextCategoryId = 1;
  let rowCount = 0;
  let availableOffers = 0;
  let unavailableOffers = 0;
  let priceMin: number | null = null;
  let priceMax: number | null = null;
  const sampleRows: CatalogImportSampleRow[] = [];

  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r]!;
    const rawId = cell(row, idIdx);
    const name = sanitizeText(cell(row, nameIdx));
    if (!rawId || !name) {
      warnings.push(`Рядок ${r + 1}: пропущено (немає ID або Name)`);
      continue;
    }

    const offerId = Number(rawId);
    if (!Number.isFinite(offerId)) {
      warnings.push(`Рядок ${r + 1}: некоректний ID «${rawId}»`);
      continue;
    }

    rowCount += 1;
    const categoryName = sanitizeText(cell(row, categoriesIdx)) || 'Без категорії';
    if (!categoryNames.has(categoryName)) {
      categoryNames.set(categoryName, nextCategoryId++);
    }

    const basePrice = parseShopExpressPrice(cell(row, priceIdx));
    const actionPrice = parseShopExpressPrice(cell(row, actionPriceIdx));
    const price = actionPrice > 0 ? actionPrice : basePrice;

    if (price > 0) {
      priceMin = priceMin == null ? price : Math.min(priceMin, price);
      priceMax = priceMax == null ? price : Math.max(priceMax, price);
    }

    const availableRaw = cell(row, isAvailableIdx);
    const available =
      !availableRaw ||
      /^available$/i.test(availableRaw) ||
      availableRaw === '1' ||
      /^так$/i.test(availableRaw);
    const stockRaw = cell(row, inStockIdx);
    let qty = Math.max(0, Math.floor(parseShopExpressPrice(stockRaw)));
    // Shop-Express often exports InStock=0 while IsAvailable=Available — treat as sellable.
    if (available && qty <= 0) qty = 1;
    if (!available) {
      qty = 0;
      unavailableOffers += 1;
    } else {
      availableOffers += 1;
    }

    const modification = sanitizeText(cell(row, modIdx));
    const props = parseProperties(headers, row, modification);
    const images = cell(row, imagesIdx);
    const thumb = images.split(/[|,]/)[0]?.trim() || null;
    const desc =
      sanitizeText(cell(row, shortDescIdx)) ||
      sanitizeText(cell(row, nameDescIdx)) ||
      null;

    const groupKey = `${name.toLowerCase()}||${categoryName.toLowerCase()}`;
    let acc = groups.get(groupKey);
    if (!acc) {
      acc = {
        name,
        categoryName,
        description: desc,
        thumbnailUrl: thumb,
        currencyCode: cell(row, currencyIdx) || 'UAH',
        offers: [],
        rowIds: [],
      };
      groups.set(groupKey, acc);
    }
    acc.rowIds.push(offerId);
    if (!acc.thumbnailUrl && thumb) acc.thumbnailUrl = thumb;
    if (!acc.description && desc) acc.description = desc;

    const offer: CrmOffer = {
      id: offerId,
      productId: 0, // filled after product id chosen
      sku: sanitizeText(cell(row, skuIdx)) || null,
      barcode: sanitizeText(cell(row, barcodeIdx)) || null,
      thumbnailUrl: thumb,
      price,
      purchasedPrice: 0,
      quantity: qty,
      inReserve: 0,
      properties: props,
      isArchived: !available,
    };
    acc.offers.push(offer);

    if (sampleRows.length < 25) {
      sampleRows.push({
        rawName: name,
        rawPrice: cell(row, priceIdx),
        rawSku: cell(row, skuIdx),
        rawModification: modification,
        rawAvailable: availableRaw,
        mappedProductId: 0,
        mappedOfferId: offerId,
        mappedPrice: price,
        mappedQty: qty,
        mappedArchived: !available,
      });
    }
  }

  if (groups.size === 0) {
    throw new Error('Не вдалося розпізнати жодного товару в CSV');
  }

  const categories: CrmCategory[] = [...categoryNames.entries()].map(([name, id]) => ({
    id,
    name,
    parentId: null,
  }));

  const products: CrmProduct[] = [];
  const offers: CrmOffer[] = [];

  for (const acc of groups.values()) {
    const productId = Math.min(...acc.rowIds);
    const livePrices = acc.offers.filter((o) => !o.isArchived && o.price > 0).map((o) => o.price);
    const allPrices = acc.offers.filter((o) => o.price > 0).map((o) => o.price);
    const prices = livePrices.length > 0 ? livePrices : allPrices;
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;
    const quantity = acc.offers.reduce((s, o) => s + (o.isArchived ? 0 : o.quantity), 0);

    products.push({
      id: productId,
      name: acc.name,
      description: acc.description,
      thumbnailUrl: acc.thumbnailUrl,
      attachmentsData: [],
      quantity,
      currencyCode: acc.currencyCode || 'UAH',
      minPrice,
      maxPrice,
      hasOffers: acc.offers.length > 0,
      isArchived: acc.offers.every((o) => o.isArchived),
      categoryId: categoryNames.get(acc.categoryName) ?? null,
      createdAt: now,
      updatedAt: now,
    });

    for (const offer of acc.offers) {
      offers.push({ ...offer, productId });
    }
  }

  // Fill sample product ids
  const offerToProduct = new Map(offers.map((o) => [o.id, o.productId]));
  for (const s of sampleRows) {
    s.mappedProductId = offerToProduct.get(s.mappedOfferId) ?? 0;
  }

  if (warnings.length > 40) {
    warnings.splice(40, warnings.length, `…ще ${warnings.length - 40} попереджень`);
  }

  const stats: CatalogImportStats = {
    rowCount,
    productCount: products.length,
    offerCount: offers.length,
    categoryCount: categories.length,
    availableOffers,
    unavailableOffers,
    priceMin,
    priceMax,
    parseWarnings: warnings,
  };

  return {
    source: 'shop_express',
    products,
    offers,
    categories,
    stats,
    sampleRows,
  };
}
