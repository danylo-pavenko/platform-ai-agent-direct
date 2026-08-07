import { describe, expect, it } from 'vitest';
import type { CrmServiceItem } from '../services/crm/types.js';
import {
  formatGradeBreakdown,
  formatResolvedPrice,
  gradePriceBreakdown,
  resolveServicePrice,
  uniqueBranchCount,
} from './service-price-resolve.js';

function svc(partial: Partial<CrmServiceItem> & Pick<CrmServiceItem, 'id' | 'name'>): CrmServiceItem {
  return {
    price: 0,
    durationMin: 45,
    ...partial,
  };
}

const manicure = svc({
  id: 'm',
  name: 'Манікюр чоловічий',
  price: 400,
  priceRows: [
    { branchId: 'loc', positionId: 'junior', positionName: 'Молодший майстер', price: 400 },
    { branchId: 'loc', positionId: 'master', positionName: 'Майстер', price: 500 },
    { branchId: 'loc', positionId: 'top', positionName: 'Топ майстер', price: 550 },
    { branchId: 'loc', positionId: 'premium', positionName: 'Преміум майстер', price: 650 },
    { branchId: 'loc2', positionId: 'top', positionName: 'Топ майстер', price: 560 },
  ],
});

describe('resolveServicePrice', () => {
  it('returns range without master', () => {
    const r = resolveServicePrice(manicure);
    expect(r).toEqual({ kind: 'range', min: 400, max: 650 });
    expect(formatResolvedPrice(r)).toBe('400–650 ₴');
  });

  it('picks max matching grade for premium master', () => {
    const r = resolveServicePrice(manicure, {
      branchId: 'loc',
      masterPositionIds: ['premium'],
    });
    expect(r).toEqual({
      kind: 'fixed',
      price: 650,
      positionName: 'Преміум майстер',
    });
  });

  it('picks top master price at branch', () => {
    const r = resolveServicePrice(manicure, {
      branchId: 'loc',
      masterPositionIds: ['top'],
    });
    expect(r.kind).toBe('fixed');
    if (r.kind === 'fixed') expect(r.price).toBe(550);
  });

  it('returns unavailable when master grade has no price row', () => {
    const limited = svc({
      id: 'x',
      name: 'Преміум-only',
      price: 800,
      priceRows: [
        { branchId: 'loc', positionId: 'premium', positionName: 'Преміум майстер', price: 800 },
      ],
    });
    const r = resolveServicePrice(limited, { masterPositionIds: ['junior'] });
    expect(r.kind).toBe('unavailable');
  });
});

describe('gradePriceBreakdown / uniqueBranchCount', () => {
  it('lists unique grades sorted by price', () => {
    const grades = gradePriceBreakdown(manicure);
    expect(grades.map((g) => g.positionName)).toEqual([
      'Молодший майстер',
      'Майстер',
      'Топ майстер',
      'Преміум майстер',
    ]);
    expect(formatGradeBreakdown(manicure)).toContain('Преміум майстер: 650');
  });

  it('counts unique branches not grade rows', () => {
    expect(uniqueBranchCount(manicure)).toBe(2);
  });
});
