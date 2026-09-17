import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseDelimitedCsv,
  parseShopExpressCsv,
  parseShopExpressPrice,
} from './shop-express.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, '../fixtures/shop-express-sample.csv');

describe('Shop-Express CSV parser', () => {
  it('parses comma-decimal prices', () => {
    expect(parseShopExpressPrice('1100,0000')).toBe(1100);
    expect(parseShopExpressPrice('1 490,50')).toBe(1490.5);
  });

  it('parses quoted CSV with semicolon delimiter', () => {
    const rows = parseDelimitedCsv('"a";"b ""c"""\n"1";"2"', ';');
    expect(rows).toEqual([
      ['a', 'b "c"'],
      ['1', '2'],
    ]);
  });

  it('groups modifications by name+category from fixture', () => {
    const csv = readFileSync(fixturePath, 'utf8');
    const draft = parseShopExpressCsv(csv);

    expect(draft.source).toBe('shop_express');
    expect(draft.stats.rowCount).toBeGreaterThanOrEqual(8);
    expect(draft.products.length).toBeGreaterThan(0);
    expect(draft.offers.length).toBe(draft.stats.offerCount);

    const jesus = draft.products.find((p) => p.name.includes('Ісус'));
    expect(jesus).toBeTruthy();
    expect(jesus!.minPrice).toBe(1100);
    expect(jesus!.maxPrice).toBe(1100);

    const offers = draft.offers.filter((o) => o.productId === jesus!.id);
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(offers.every((o) => o.price === 1100)).toBe(true);
    // Available + InStock 0 → qty 1
    expect(offers.some((o) => o.quantity >= 1 && !o.isArchived)).toBe(true);
  });
});
