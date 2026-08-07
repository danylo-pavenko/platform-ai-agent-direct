import { describe, expect, it } from 'vitest';
import { normalizeOrderItems, parseOrderKind } from './order-normalize.js';

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
});
