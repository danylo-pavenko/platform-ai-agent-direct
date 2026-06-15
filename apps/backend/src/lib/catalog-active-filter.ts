import type { CrmOffer, CrmProduct } from '../services/crm/types.js';

/** Non-archived products only — safe for catalog and agent context. */
export function filterActiveProducts(products: CrmProduct[]): CrmProduct[] {
  return products.filter((p) => !p.isArchived);
}

/**
 * Non-archived offers for live products only.
 * When `liveProductIds` is omitted, only `isArchived` is checked.
 */
export function filterActiveOffers(
  offers: CrmOffer[],
  liveProductIds?: ReadonlySet<number>,
): CrmOffer[] {
  return offers.filter((o) => {
    if (o.isArchived) return false;
    if (liveProductIds && !liveProductIds.has(o.productId)) return false;
    return true;
  });
}

export function activeCatalogSets(products: CrmProduct[], offers: CrmOffer[]) {
  const liveProducts = filterActiveProducts(products);
  const liveProductIds = new Set(liveProducts.map((p) => p.id));
  const liveOffers = filterActiveOffers(offers, liveProductIds);
  return { liveProducts, liveProductIds, liveOffers };
}
