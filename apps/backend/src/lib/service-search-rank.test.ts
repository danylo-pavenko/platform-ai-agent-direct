import { describe, expect, it } from 'vitest';
import type { CrmServiceItem } from '../services/crm/types.js';
import {
  expandServiceQueries,
  formatServiceLine,
  formatServicePrice,
  rankAcrossQueries,
  rankServices,
  scoreServiceMatch,
  tokenizeServiceQuery,
} from './service-search-rank.js';

function svc(partial: Partial<CrmServiceItem> & Pick<CrmServiceItem, 'id' | 'name'>): CrmServiceItem {
  return {
    price: 0,
    durationMin: 45,
    ...partial,
  };
}

describe('tokenizeServiceQuery', () => {
  it('splits cyrillic words', () => {
    expect(tokenizeServiceQuery('Чоловічий манікюр!')).toEqual(['чоловічий', 'манікюр']);
  });
});

describe('scoreServiceMatch', () => {
  it('matches word order independently', () => {
    const item = svc({ id: '1', name: 'Манікюр чоловічий', price: 500 });
    const score = scoreServiceMatch(item, 'чоловічий манікюр');
    expect(score).toBeGreaterThan(1);
  });

  it('prefers gendered name over bare keyword match', () => {
    const male = svc({ id: '1', name: 'Манікюр чоловічий', price: 500 });
    const generic = svc({ id: '2', name: 'Гігієнічний манікюр + покриття', price: 700 });
    const q = 'чоловічий манікюр';
    expect(scoreServiceMatch(male, q)).toBeGreaterThan(scoreServiceMatch(generic, q));
  });

  it('penalizes category-only matches', () => {
    const onlyCat = svc({ id: '1', name: 'Масаж спини', categoryName: 'Манікюр', price: 400 });
    const nameHit = svc({ id: '2', name: 'Манікюр класичний', categoryName: 'Нігті', price: 500 });
    const q = 'манікюр';
    expect(scoreServiceMatch(nameHit, q)).toBeGreaterThan(scoreServiceMatch(onlyCat, q));
  });

  it('returns 0 for empty query', () => {
    expect(scoreServiceMatch(svc({ id: '1', name: 'Манікюр' }), '  ')).toBe(0);
  });
});

describe('expandServiceQueries', () => {
  it('puts primary first and adds broaden alts', () => {
    const q = expandServiceQueries('чоловічий манікюр без покриття');
    expect(q[0]).toBe('чоловічий манікюр без покриття');
    expect(q).toContain('манікюр');
  });

  it('returns empty for blank', () => {
    expect(expandServiceQueries('   ')).toEqual([]);
  });
});

describe('rankServices / rankAcrossQueries', () => {
  const catalog = [
    svc({ id: 'a', name: 'Гігієнічна чистка + японський манікюр', price: 850, categoryName: 'Манікюр' }),
    svc({
      id: 'b',
      name: 'Манікюр чоловічий',
      price: 500,
      categoryName: 'Манікюр',
      branchPrices: [
        { branchId: '1', branchName: '1', price: 500 },
        { branchId: '2', branchName: '2', price: 550 },
      ],
    }),
    svc({ id: 'c', name: 'Чистка комбінована/ класична', price: 400, categoryName: 'Манікюр' }),
    svc({ id: 'd', name: 'Видалення мозолів до 3-ьох', price: 520, categoryName: 'Подологія' }),
  ];

  it('ranks чоловічий манікюр to the male service first', () => {
    const ranked = rankServices(catalog, 'чоловічий манікюр', 5);
    expect(ranked[0]?.id).toBe('b');
  });

  it('rankAcrossQueries finds via broaden when primary substring would miss', () => {
    // Contiguous includes fails on word order; token score still hits primary.
    const result = rankAcrossQueries(catalog, expandServiceQueries('чоловічий манікюр'), 8);
    expect(result.items[0]?.id).toBe('b');
    expect(result.usedQuery).toBe('чоловічий манікюр');
    expect(result.broadenedFrom).toBeUndefined();
  });

  it('sets broadenedFrom when only keyword variant matches', () => {
    const withManicure = [
      svc({ id: 'x', name: 'Класична чистка нігтів', price: 400 }),
      svc({ id: 'm', name: 'Манікюр класичний', price: 600 }),
    ];
    // Primary has no overlapping tokens with catalog names → broaden to «манікюр»
    const r = rankAcrossQueries(
      withManicure,
      expandServiceQueries('хочу записатись на манікюр будь ласка'),
      5,
    );
    // Primary includes «манікюр» so usedQuery stays primary
    expect(r.items.some((i) => i.id === 'm')).toBe(true);
    expect(r.usedQuery).toContain('манікюр');

    const noPrimaryToken = rankAcrossQueries(
      withManicure,
      // broadenServiceQueries extracts «манікюр» from phrase that still tokenizes it —
      // use a phrase where only stripped/keyword path helps after empty primary:
      ['zzzz-немає-збігу', 'манікюр'],
      5,
    );
    expect(noPrimaryToken.items[0]?.id).toBe('m');
    expect(noPrimaryToken.broadenedFrom).toBe('zzzz-немає-збігу');
    expect(noPrimaryToken.usedQuery).toBe('манікюр');
  });

  it('respects limit', () => {
    const ranked = rankServices(catalog, 'манікюр', 2);
    expect(ranked).toHaveLength(2);
  });
});

describe('formatServicePrice / formatServiceLine', () => {
  it('formats single price as від', () => {
    expect(formatServicePrice(svc({ id: '1', name: 'X', price: 850 }))).toBe('від 850 ₴');
  });

  it('formats branch price range', () => {
    const item = svc({
      id: '1',
      name: 'Манікюр чоловічий',
      price: 500,
      branchPrices: [
        { branchId: 'a', branchName: 'a', price: 500 },
        { branchId: 'b', branchName: 'b', price: 550 },
      ],
    });
    expect(formatServicePrice(item)).toBe('500–550 ₴');
    expect(formatServiceLine(item)).toContain('500–550 ₴');
    expect(formatServiceLine(item)).toContain('[service_id=1]');
  });

  it('includes grade breakdown from priceRows', () => {
    const item = svc({
      id: '1',
      name: 'Манікюр чоловічий',
      price: 400,
      priceRows: [
        { branchId: 'a', positionId: 'j', positionName: 'Молодший майстер', price: 400 },
        { branchId: 'a', positionId: 'p', positionName: 'Преміум майстер', price: 650 },
      ],
    });
    expect(formatServicePrice(item)).toBe('400–650 ₴');
    expect(formatServiceLine(item)).toContain('Молодший майстер: 400');
    expect(formatServiceLine(item)).toContain('Преміум майстер: 650');
  });

  it('handles missing price', () => {
    expect(formatServicePrice(svc({ id: '1', name: 'X', price: 0 }))).toBe('ціна за запитом');
  });
});
