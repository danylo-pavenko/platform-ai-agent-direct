/** Pure helpers for order line items / soft local orders (no I/O). */

const VALID_ORDER_KINDS = ['product', 'service', 'callback', 'other', 'booking'] as const;
export type LocalOrderKind = (typeof VALID_ORDER_KINDS)[number];

export interface OrderLineItem {
  name: string;
  variant?: string;
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
    return {
      name:
        typeof row.name === 'string' && row.name.trim()
          ? row.name.trim()
          : fallbackName,
      variant:
        typeof row.variant === 'string' && row.variant.trim()
          ? row.variant.trim()
          : undefined,
      price: Number(row.price) || 0,
      qty: Number(row.qty) > 0 ? Number(row.qty) : 1,
    };
  });

  return normalised.length > 0 ? normalised : [{ name: fallbackName, price: 0, qty: 1 }];
}
