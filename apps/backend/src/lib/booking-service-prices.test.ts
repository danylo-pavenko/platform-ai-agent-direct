import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./synced-services.js', () => ({
  loadSyncedServices: vi.fn(),
}));

vi.mock('./crm-routing.js', () => ({
  resolveCrmProvider: vi.fn(async () => 'beautypro'),
}));

vi.mock('../services/crm/index.js', () => ({
  getCrmAdapter: vi.fn(() => ({
    fetchServices: vi.fn(async () => [
      {
        id: 'svc-brow',
        name: 'Моделювання брів',
        price: 0,
        durationMin: 30,
        priceRows: [
          { branchId: 'loc', positionId: 'm', positionName: 'Майстер', price: 450 },
        ],
      },
    ]),
  })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => '[]'),
}));

import { loadSyncedServices } from './synced-services.js';
import {
  enrichAppointmentServicePrices,
  enrichBookingOrderItems,
} from './booking-service-prices.js';

describe('booking-service-prices', () => {
  beforeEach(() => {
    vi.mocked(loadSyncedServices).mockReset();
  });

  it('fills zero prices from synced priceRows', async () => {
    vi.mocked(loadSyncedServices).mockResolvedValue([
      {
        id: 'svc-brow',
        name: 'Моделювання брів',
        price: 0,
        durationMin: 30,
        provider: 'beautypro',
        priceRows: [
          { branchId: 'loc', positionId: 'm', positionName: 'Майстер', price: 450 },
          { branchId: 'loc', positionId: 't', positionName: 'Топ', price: 550 },
        ],
      },
    ]);

    const out = await enrichAppointmentServicePrices([
      { id: 'svc-brow', name: 'Моделювання брів', durationMin: 30, price: 0 },
    ]);
    expect(out[0]?.price).toBe(450);
  });

  it('falls back to live CRM when snapshot has no usable price', async () => {
    vi.mocked(loadSyncedServices).mockResolvedValue([
      {
        id: 'svc-brow',
        name: 'Моделювання брів',
        price: 0,
        durationMin: 30,
        provider: 'beautypro',
      },
    ]);

    const out = await enrichAppointmentServicePrices([
      { id: 'svc-brow', name: 'Моделювання брів', durationMin: 30, price: 0 },
    ]);
    expect(out[0]?.price).toBe(450);
  });

  it('enriches order lines by name from appointment services', async () => {
    vi.mocked(loadSyncedServices).mockResolvedValue([
      {
        id: 'svc-cut',
        name: 'Стрижка кінчиків',
        price: 300,
        durationMin: 20,
        provider: 'beautypro',
      },
    ]);

    const { items, changed } = await enrichBookingOrderItems(
      [
        { name: 'Моделювання брів', price: 0, qty: 1 },
        { name: 'Стрижка кінчиків', price: 0, qty: 1 },
      ],
      [
        { id: 'svc-brow', name: 'Моделювання брів', durationMin: 30, price: 0 },
        { id: 'svc-cut', name: 'Стрижка кінчиків', durationMin: 20, price: 0 },
      ],
    );
    expect(changed).toBe(true);
    expect(items[0]?.price).toBe(450);
    expect(items[1]?.price).toBe(300);
  });
});
