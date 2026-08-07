import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadSyncedServices, resolveCrmProvider, getCrmAdapter } = vi.hoisted(() => ({
  loadSyncedServices: vi.fn(),
  resolveCrmProvider: vi.fn(async () => 'beautypro'),
  getCrmAdapter: vi.fn(),
}));

vi.mock('../lib/synced-services.js', () => ({ loadSyncedServices }));
vi.mock('../lib/crm-routing.js', () => ({ resolveCrmProvider }));
vi.mock('./crm/index.js', () => ({ getCrmAdapter }));

import { searchServicesForContext } from './service-search.js';

describe('searchServicesForContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCrmProvider.mockResolvedValue('beautypro');
  });

  it('uses synced snapshot when it has ranked hits', async () => {
    loadSyncedServices.mockResolvedValue([
      {
        id: 'b',
        name: 'Манікюр чоловічий',
        price: 500,
        durationMin: 45,
        provider: 'beautypro',
        branchPrices: [
          { branchId: '1', branchName: '1', price: 500 },
          { branchId: '2', branchName: '2', price: 550 },
        ],
      },
      {
        id: 'a',
        name: 'Гігієнічний манікюр',
        price: 700,
        durationMin: 60,
        provider: 'beautypro',
      },
    ]);
    const fetchServices = vi.fn(async () => {
      throw new Error('should not call live');
    });
    getCrmAdapter.mockReturnValue({ fetchServices });

    const result = await searchServicesForContext('чоловічий манікюр', 5);
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.contextBlock).toContain('Манікюр чоловічий');
    expect(result.contextBlock).toContain('500–550 ₴');
    expect(result.usedQuery).toBe('чоловічий манікюр');
    expect(fetchServices).not.toHaveBeenCalled();
  });

  it('falls back to live CRM when snapshot has no hits', async () => {
    loadSyncedServices.mockResolvedValue([
      {
        id: 'x',
        name: 'Масаж обличчя',
        price: 900,
        durationMin: 60,
        provider: 'beautypro',
      },
    ]);
    const fetchServices = vi.fn(async () => [
      {
        id: 'b',
        name: 'Манікюр чоловічий',
        price: 500,
        durationMin: 45,
      },
    ]);
    getCrmAdapter.mockReturnValue({ fetchServices });

    const result = await searchServicesForContext('чоловічий манікюр');
    expect(fetchServices).toHaveBeenCalled();
    expect(result.contextBlock).toContain('Манікюр чоловічий');
  });
});
