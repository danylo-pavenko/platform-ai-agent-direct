import { describe, expect, it } from 'vitest';
import type { CrmProduct } from '../services/crm/types.js';
import {
  scoreProductNameMatch,
  searchLocalProducts,
  tokenizeProductQuery,
} from './catalog-index.js';

const product = (id: number, name: string, archived = false): CrmProduct => ({
  id,
  name,
  description: null,
  thumbnailUrl: null,
  attachmentsData: [],
  quantity: 5,
  currencyCode: 'UAH',
  minPrice: 1000,
  maxPrice: 1000,
  hasOffers: true,
  isArchived: archived,
  categoryId: 1,
  createdAt: '',
  updatedAt: '',
});

describe('tokenizeProductQuery', () => {
  it('splits words and drops single-char noise', () => {
    expect(tokenizeProductQuery('біла футболка Blessed xs')).toEqual([
      'біла',
      'футболка',
      'blessed',
      'xs',
    ]);
  });
});

describe('searchLocalProducts', () => {
  const catalog = [
    product(1, 'Футболка Blessed біла'),
    product(2, 'Худі Status Blessed чорне'),
    product(3, 'Кепка SB', true),
  ];

  it('ranks best name match first', () => {
    const hits = searchLocalProducts(catalog, 'біла футболка blessed', 3);
    expect(hits[0]?.id).toBe(1);
  });

  it('skips archived products', () => {
    const hits = searchLocalProducts(catalog, 'кепка sb', 3);
    expect(hits).toHaveLength(0);
  });
});

describe('scoreProductNameMatch', () => {
  it('prefers full phrase hits', () => {
    const partial = scoreProductNameMatch('футболка blessed', ['біла', 'футболка'], 'біла футболка');
    const full = scoreProductNameMatch(
      'футболка blessed біла',
      ['біла', 'футболка'],
      'біла футболка',
    );
    expect(full).toBeGreaterThan(partial);
  });
});
