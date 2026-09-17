import { describe, expect, it } from 'vitest';
import {
  computeAutoMatches,
  nameMatchScore,
  normalizeSku,
} from './catalog-match.js';
import type { CrmOffer, CrmProduct } from '../crm/types.js';

function product(partial: Partial<CrmProduct> & { id: number; name: string }): CrmProduct {
  return {
    description: null,
    thumbnailUrl: null,
    attachmentsData: [],
    quantity: 1,
    currencyCode: 'UAH',
    minPrice: 100,
    maxPrice: 100,
    hasOffers: true,
    isArchived: false,
    categoryId: null,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

function offer(
  partial: Partial<CrmOffer> & { id: number; productId: number },
): CrmOffer {
  return {
    sku: null,
    barcode: null,
    thumbnailUrl: null,
    price: 100,
    purchasedPrice: 0,
    quantity: 1,
    inReserve: 0,
    properties: [],
    isArchived: false,
    ...partial,
  };
}

describe('catalog-match', () => {
  it('normalizes SKUs', () => {
    expect(normalizeSku('AB-12_3')).toBe('ab123');
    expect(normalizeSku('  Sku_1 ')).toBe('sku1');
  });

  it('scores exact and overlapping names', () => {
    expect(nameMatchScore('Худі таш', 'Худі таш')).toBe(1);
    expect(nameMatchScore('Худі «таш» чорний', 'Худі таш')).toBeGreaterThan(0.7);
    expect(nameMatchScore('ab', 'cd')).toBe(0);
  });

  it('matches by SKU with high confidence', () => {
    const matches = computeAutoMatches({
      manualProducts: [product({ id: 1, name: 'Hoodie File', minPrice: 2000, maxPrice: 2000 })],
      manualOffers: [offer({ id: 11, productId: 1, sku: 'SKU-99', price: 2000 })],
      crmProducts: [product({ id: 50, name: 'Other name', minPrice: 2100, maxPrice: 2100 })],
      crmOffers: [offer({ id: 51, productId: 50, sku: 'sku99', price: 2100 })],
    });
    expect(matches).toEqual([
      expect.objectContaining({
        manualProductId: 1,
        crmProductId: 50,
        method: 'sku',
        confidence: 'high',
      }),
    ]);
  });

  it('matches by name when SKU missing', () => {
    const matches = computeAutoMatches({
      manualProducts: [product({ id: 1, name: 'Світшот Господь спасає' })],
      manualOffers: [offer({ id: 11, productId: 1, sku: null })],
      crmProducts: [product({ id: 50, name: 'Світшот Господь спасає' })],
      crmOffers: [offer({ id: 51, productId: 50, sku: 'x' })],
    });
    expect(matches[0]).toMatchObject({
      manualProductId: 1,
      crmProductId: 50,
      method: 'name',
    });
  });

  it('preserves manual overrides on rebuild', () => {
    const matches = computeAutoMatches({
      manualProducts: [product({ id: 1, name: 'A' })],
      manualOffers: [offer({ id: 11, productId: 1, sku: 'zzz' })],
      crmProducts: [
        product({ id: 50, name: 'B' }),
        product({ id: 60, name: 'A' }),
      ],
      crmOffers: [
        offer({ id: 51, productId: 50, sku: 'zzz' }),
        offer({ id: 61, productId: 60, sku: 'other' }),
      ],
      preserveManual: [
        {
          manualProductId: 1,
          crmProductId: 60,
          method: 'manual',
          confidence: 'high',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(matches[0]?.crmProductId).toBe(60);
    expect(matches[0]?.method).toBe('manual');
  });
});
