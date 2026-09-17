/** Order totals: catalog sum vs quoted-to-customer. */

import {
  resolveQuotedTotal,
  sumCatalogTotal,
  type OrderLineItem,
} from './order-normalize.js';

/** Sum line items stored as Prisma Json (qty × catalog price). */
export function computeOrderTotal(items: unknown): number {
  return sumCatalogTotal(items);
}

export function computeOrderTotals(
  items: unknown,
  quotedTotal: number | null | undefined,
): {
  catalogTotal: number;
  quotedTotal: number;
  delta: number;
} {
  const catalogTotal = Math.round(sumCatalogTotal(items) * 100) / 100;
  const quoted = resolveQuotedTotal(quotedTotal, items as OrderLineItem[]);
  return {
    catalogTotal,
    quotedTotal: quoted,
    delta: Math.round((quoted - catalogTotal) * 100) / 100,
  };
}
