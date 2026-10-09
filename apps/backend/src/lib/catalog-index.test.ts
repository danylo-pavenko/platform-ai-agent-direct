import { describe, expect, it } from 'vitest';
import type { CrmProduct } from '../services/crm/types.js';
import {
  designColorSiblings,
  designGarmentMismatchNote,
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

  it('does not swap a t-shirt print onto another hoodie design', () => {
    const hits = searchLocalProducts(
      [product(10, 'Футболка Chosen'), product(11, 'Худі Child of God')],
      'чорне худі chosen by god',
      5,
    );
    expect(hits.map((hit) => hit.id)).toEqual([10]);
  });

  it('finds Дорогоцінний by a stemmed word', () => {
    const hits = searchLocalProducts(
      [product(4, 'Футболка Дорогоцінний')],
      'хочу таку футболку дорогоцінна',
      3,
    );
    expect(hits[0]?.id).toBe(4);
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

describe('designColorSiblings', () => {
  it('joins Blessed and Благословенний hoodies and skips another garment', () => {
    const all = [
      product(1, 'Худі (вишня) Blessed'),
      product(2, 'Худі чорний "Благословенний"'),
      product(3, 'Футболка "Благословенний"'),
      product(4, 'Худі рожевий "Благословенний"', true),
    ];
    const extras = designColorSiblings(all, ['Худі (вишня) Blessed']);
    expect(extras.map((item) => item.id)).toEqual([2]);
  });
});

describe('designGarmentMismatchNote', () => {
  it('warns when the print exists only on another garment', () => {
    const note = designGarmentMismatchNote('худі chosen', ['Футболка Chosen']);
    expect(note).toMatch(/іншому типі виробу/);
  });

  it('stays quiet when the same garment has the print', () => {
    expect(designGarmentMismatchNote('худі child of god', ['Худі Child of God'])).toBeNull();
  });
});
