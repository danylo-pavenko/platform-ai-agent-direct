/** Pure helpers for order line items / soft local orders (no I/O). */

const VALID_ORDER_KINDS = ['product', 'service', 'callback', 'other', 'booking'] as const;
export type LocalOrderKind = (typeof VALID_ORDER_KINDS)[number];

export interface OrderLineItem {
  name: string;
  variant?: string;
  /** Catalog / list price from search_catalog or file. */
  price: number;
  qty: number;
}

export function parseOrderKind(value: unknown): LocalOrderKind | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (VALID_ORDER_KINDS.includes(v as LocalOrderKind)) {
    return v as LocalOrderKind;
  }
  return null;
}

export function normalizeOrderItems(
  rawItems: unknown,
  summaryFallback: string,
): OrderLineItem[] {
  const fallbackName = summaryFallback.trim() || 'Угода з клієнтом';
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return [{ name: fallbackName, price: 0, qty: 1 }];
  }

  const normalised = rawItems.map((item) => {
    const row =
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const catalogRaw =
      row.catalogPrice != null ? row.catalogPrice : row.catalog_price != null ? row.catalog_price : row.price;
    return {
      name:
        typeof row.name === 'string' && row.name.trim()
          ? row.name.trim()
          : fallbackName,
      variant:
        typeof row.variant === 'string' && row.variant.trim()
          ? row.variant.trim()
          : undefined,
      price: Number(catalogRaw) || 0,
      qty: Number(row.qty) > 0 ? Number(row.qty) : 1,
    };
  });

  return normalised.length > 0 ? normalised : [{ name: fallbackName, price: 0, qty: 1 }];
}

/** Sum of catalog line prices (qty × price). */
export function sumCatalogTotal(items: OrderLineItem[] | unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sum;
    const o = raw as Record<string, unknown>;
    const price = typeof o.price === 'number' ? o.price : Number(o.price) || 0;
    const qty = typeof o.qty === 'number' && o.qty > 0 ? o.qty : Number(o.qty) > 0 ? Number(o.qty) : 1;
    return sum + price * qty;
  }, 0);
}

/**
 * Final amount quoted to the customer.
 * Falls back to catalog sum when quoted is missing (legacy orders).
 */
export function resolveQuotedTotal(
  quoted: unknown,
  items: OrderLineItem[] | unknown,
): number {
  if (typeof quoted === 'number' && Number.isFinite(quoted) && quoted >= 0) {
    return Math.round(quoted * 100) / 100;
  }
  if (typeof quoted === 'string' && quoted.trim()) {
    const n = Number(quoted.replace(',', '.').replace(/\s+/g, ''));
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }
  return Math.round(sumCatalogTotal(items) * 100) / 100;
}

export function parseQuotedTotalArg(args: Record<string, unknown>): number | null {
  const raw = args.quoted_total ?? args.quotedTotal;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.round(raw * 100) / 100;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw.replace(',', '.').replace(/\s+/g, ''));
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }
  return null;
}

/**
 * Scale catalog line prices so line totals sum to quotedTotal (for CRM mirror).
 * Last line absorbs rounding remainder.
 */
export function scaleItemsToQuotedTotal(
  items: OrderLineItem[],
  quotedTotal: number,
): OrderLineItem[] {
  if (items.length === 0) return items;
  const catalog = sumCatalogTotal(items);
  const target = Math.round(quotedTotal * 100) / 100;
  if (catalog <= 0) {
    // Put entire quoted amount on first line
    return items.map((item, i) =>
      i === 0 ? { ...item, price: target / (item.qty || 1) } : { ...item, price: 0 },
    );
  }
  if (Math.abs(catalog - target) < 0.01) return items.map((i) => ({ ...i }));

  const factor = target / catalog;
  const scaled = items.map((item) => ({
    ...item,
    price: Math.round(item.price * factor * 100) / 100,
  }));
  const scaledSum = sumCatalogTotal(scaled);
  const delta = Math.round((target - scaledSum) * 100) / 100;
  if (Math.abs(delta) >= 0.01 && scaled.length > 0) {
    const last = scaled[scaled.length - 1]!;
    const qty = last.qty || 1;
    last.price = Math.round((last.price + delta / qty) * 100) / 100;
  }
  return scaled;
}
