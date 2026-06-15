import { describe, expect, it } from 'vitest';
import {
  activeCatalogSets,
  filterActiveOffers,
  filterActiveProducts,
} from './catalog-active-filter.js';
import type { CrmOffer, CrmProduct } from '../services/crm/types.js';

const product = (id: number, archived = false): CrmProduct => ({
  id,
  name: `Product ${id}`,
  description: null,
  thumbnailUrl: null,
  attachmentsData: [],
  quantity: 1,
  currencyCode: 'UAH',
  minPrice: 100,
  maxPrice: 100,
  hasOffers: true,
  isArchived: archived,
  categoryId: null,
  createdAt: '',
  updatedAt: '',
});

const offer = (id: number, productId: number, archived = false): CrmOffer => ({
  id,
  productId,
  sku: null,
  barcode: null,
  thumbnailUrl: null,
  price: 100,
  purchasedPrice: 50,
  quantity: 2,
  inReserve: 0,
  properties: [],
  isArchived: archived,
});

describe('filterActiveProducts', () => {
  it('removes archived products', () => {
    const items = [product(1), product(2, true)];
    expect(filterActiveProducts(items).map((p) => p.id)).toEqual([1]);
  });
});

describe('filterActiveOffers', () => {
  it('removes archived offers and offers of archived products', () => {
    const liveIds = new Set([1]);
    const items = [
      offer(10, 1),
      offer(11, 1, true),
      offer(12, 2),
    ];
    expect(filterActiveOffers(items, liveIds).map((o) => o.id)).toEqual([10]);
  });
});

describe('activeCatalogSets', () => {
  it('returns consistent live product and offer sets', () => {
    const products = [product(1), product(2, true)];
    const offers = [offer(10, 1), offer(11, 2), offer(12, 1, true)];
    const { liveProducts, liveOffers } = activeCatalogSets(products, offers);
    expect(liveProducts.map((p) => p.id)).toEqual([1]);
    expect(liveOffers.map((o) => o.id)).toEqual([10]);
  });
});
