import { describe, expect, it } from 'vitest';
import {
  normalizeOrderItems,
  parseOrderKind,
  resolveQuotedTotal,
  scaleItemsToQuotedTotal,
  sumCatalogTotal,
} from './order-normalize.js';
import { computeOrderTotals } from './order-totals.js';

describe('parseOrderKind', () => {
  it('accepts known kinds', () => {
    expect(parseOrderKind('product')).toBe('product');
    expect(parseOrderKind('SERVICE')).toBe('service');
    expect(parseOrderKind('callback')).toBe('callback');
    expect(parseOrderKind('booking')).toBe('booking');
  });

  it('rejects unknown', () => {
    expect(parseOrderKind('foo')).toBeNull();
    expect(parseOrderKind(null)).toBeNull();
  });
});

describe('normalizeOrderItems', () => {
  it('falls back to summary as a single line item', () => {
    expect(normalizeOrderItems(undefined, 'Манікюр + дзвінок')).toEqual([
      { name: 'Манікюр + дзвінок', price: 0, qty: 1 },
    ]);
  });

  it('normalises partial item rows', () => {
    expect(
      normalizeOrderItems([{ name: 'Худі', price: '100', qty: '2' }], 'x'),
    ).toEqual([{ name: 'Худі', price: 100, qty: 2, variant: undefined }]);
  });

  it('prefers catalogPrice alias over price when both present', () => {
    expect(
      normalizeOrderItems(
        [{ name: 'A', price: 100, catalogPrice: 90, qty: 1 }],
        'x',
      ),
    ).toEqual([{ name: 'A', price: 90, qty: 1, variant: undefined }]);
  });
});

describe('sumCatalogTotal / resolveQuotedTotal', () => {
  const items = [
    { name: 'A', price: 100, qty: 2 },
    { name: 'B', price: 50, qty: 1 },
  ];

  it('sums catalog line totals', () => {
    expect(sumCatalogTotal(items)).toBe(250);
  });

  it('uses quoted when provided', () => {
    expect(resolveQuotedTotal(200, items)).toBe(200);
  });

  it('falls back to catalog sum for legacy null', () => {
    expect(resolveQuotedTotal(null, items)).toBe(250);
    expect(resolveQuotedTotal(undefined, items)).toBe(250);
  });

  it('computeOrderTotals exposes delta', () => {
    expect(computeOrderTotals(items, 200)).toEqual({
      catalogTotal: 250,
      quotedTotal: 200,
      delta: -50,
    });
  });
});

describe('scaleItemsToQuotedTotal', () => {
  it('scales line prices proportionally to quoted total', () => {
    const scaled = scaleItemsToQuotedTotal(
      [
        { name: 'A', price: 100, qty: 1 },
        { name: 'B', price: 100, qty: 1 },
      ],
      180,
    );
    expect(sumCatalogTotal(scaled)).toBeCloseTo(180, 1);
    expect(scaled[0]!.price).toBeCloseTo(90, 0);
    expect(scaled[1]!.price).toBeCloseTo(90, 0);
  });

  it('leaves lines unchanged when quoted ≈ catalog', () => {
    const items = [{ name: 'A', price: 50, qty: 2 }];
    expect(scaleItemsToQuotedTotal(items, 100)).toEqual(items);
  });
});
