import { describe, expect, it } from 'vitest';
import { mapBeautyproService } from './beautypro.js';

describe('mapBeautyproService', () => {
  it('stores all grade prices and aggregates unique branches', () => {
    const categories = new Map([['cat-1', 'Манікюр']]);
    const positions = new Map([
      ['pos-junior', 'Молодший майстер'],
      ['pos-master', 'Майстер'],
      ['pos-top', 'Топ майстер'],
      ['pos-premium', 'Преміум майстер'],
    ]);

    const item = mapBeautyproService(
      {
        id: 'svc-1',
        name: 'Манікюр чоловічий',
        duration: 45,
        category: 'cat-1',
        location_prices: [
          { location: 'loc-a', position: 'pos-junior', price: 400, staff_price: 1 },
          { location: 'loc-a', position: 'pos-master', price: 500, staff_price: 2 },
          { location: 'loc-a', position: 'pos-top', price: 550 },
          { location: 'loc-a', position: 'pos-premium', price: 650 },
          { location: 'loc-b', position: 'pos-top', price: 560 },
        ],
      },
      categories,
      positions,
    );

    expect(item.price).toBe(400);
    expect(item.priceRows).toHaveLength(5);
    expect(item.priceRows?.map((r) => r.positionName)).toContain('Преміум майстер');
    expect(item.branchPrices).toHaveLength(2);
    expect(item.branchPrices?.every((b) => b.price > 0)).toBe(true);
    // staff_price never leaked into client rows
    expect(JSON.stringify(item)).not.toMatch(/staff_price/);
  });
});
