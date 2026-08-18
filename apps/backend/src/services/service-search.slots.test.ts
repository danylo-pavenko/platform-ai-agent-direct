import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCrmProvider, getCrmAdapter, getAvailableSlots, loadSyncedServices } = vi.hoisted(
  () => ({
    resolveCrmProvider: vi.fn(),
    getCrmAdapter: vi.fn(),
    getAvailableSlots: vi.fn(),
    loadSyncedServices: vi.fn(async () => []),
  }),
);

vi.mock('../lib/crm-routing.js', () => ({ resolveCrmProvider }));
vi.mock('./crm/index.js', () => ({ getCrmAdapter }));
vi.mock('../lib/synced-services.js', () => ({ loadSyncedServices }));

import { getAvailableSlotsForContext } from './service-search.js';

describe('getAvailableSlotsForContext preferred master', () => {
  beforeEach(() => {
    resolveCrmProvider.mockReset();
    getCrmAdapter.mockReset();
    getAvailableSlots.mockReset();
    loadSyncedServices.mockReset();
    loadSyncedServices.mockResolvedValue([]);
    resolveCrmProvider.mockResolvedValue('beautypro');
    getCrmAdapter.mockReturnValue({ getAvailableSlots });
  });

  it('passes masterId to CRM and formats master_id for book_appointment', async () => {
    getAvailableSlots.mockResolvedValue({
      slots: {
        '04.08.2026': [
          { date: '04.08.2026', time: '10:00', masterIds: ['pro-1'] },
          { date: '04.08.2026', time: '11:00', masterIds: ['pro-1'] },
        ],
      },
      masters: [{ id: 'pro-1', name: 'Анна' }],
    });
    getCrmAdapter.mockReturnValue({
      getAvailableSlots,
      fetchEmployees: vi.fn(async () => [
        { id: 'pro-1', name: 'Анна', positionIds: ['top'], positionNames: ['Топ майстер'] },
      ]),
    });
    loadSyncedServices.mockResolvedValue([
      {
        id: 'svc-1',
        name: 'Манікюр',
        price: 500,
        durationMin: 60,
        provider: 'beautypro',
        priceRows: [
          { branchId: 'loc-1', positionId: 'top', positionName: 'Топ майстер', price: 550 },
          { branchId: 'loc-1', positionId: 'junior', positionName: 'Молодший майстер', price: 400 },
        ],
      },
    ]);

    const text = await getAvailableSlotsForContext({
      date: '04.08.2026',
      branchCrmId: 'loc-1',
      services: [{ id: 'svc-1', durationMin: 60 }],
      masterId: 'pro-1',
    });

    expect(getAvailableSlots).toHaveBeenCalledWith({
      date: '04.08.2026',
      branchId: 'loc-1',
      services: [{ id: 'svc-1', durationMin: 60 }],
      fullMonth: undefined,
      masterId: 'pro-1',
    });
    expect(text).toContain('[master_id=pro-1] Анна');
    expect(text).toContain('10:00');
    expect(text).toMatch(/book_appointment/);
    expect(text).toMatch(/лише ім/);
    expect(text).toContain('Ціни для обраного майстра');
    expect(text).toContain('від 550 ₴');
  });

  it('returns a clear empty message when filtered master has no slots', async () => {
    getAvailableSlots.mockResolvedValue({ slots: {}, masters: [] });

    const text = await getAvailableSlotsForContext({
      date: '04.08.2026',
      branchCrmId: 'loc-1',
      services: [{ id: 'svc-1', durationMin: 60 }],
      masterId: 'pro-missing',
    });

    expect(text).toMatch(/цього майстра/);
    expect(text).toMatch(/без master_id/);
  });

  it('without masterId lists all masters with ids', async () => {
    getAvailableSlots.mockResolvedValue({
      slots: {
        '04.08.2026': [
          { date: '04.08.2026', time: '10:00', masterIds: ['a', 'b'] },
        ],
      },
      masters: [
        { id: 'a', name: 'Anna' },
        { id: 'b', name: 'Bohdan' },
      ],
    });

    const text = await getAvailableSlotsForContext({
      date: '04.08.2026',
      branchCrmId: 'loc-1',
      services: [{ id: 'svc-1', durationMin: 45 }],
    });

    expect(getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ masterId: undefined }),
    );
    expect(text).toContain('[master_id=a] Anna');
    expect(text).toContain('[master_id=b] Bohdan');
    expect(text).not.toMatch(/цього майстра/);
  });

  it('intersects free times when services have different masters', async () => {
    getAvailableSlots.mockImplementation(async (query: { masterId?: string }) => {
      if (query.masterId === 'nails') {
        return {
          slots: {
            '21.08.2026': [
              { date: '21.08.2026', time: '12:00', masterIds: ['nails'] },
              { date: '21.08.2026', time: '13:00', masterIds: ['nails'] },
            ],
          },
          masters: [{ id: 'nails', name: 'Анна' }],
        };
      }
      return {
        slots: {
          '21.08.2026': [
            { date: '21.08.2026', time: '12:00', masterIds: ['brows'] },
          ],
        },
        masters: [{ id: 'brows', name: 'Оля' }],
      };
    });

    const text = await getAvailableSlotsForContext({
      date: '21.08.2026',
      branchCrmId: 'loc-1',
      services: [
        { id: 'svc-1', durationMin: 115, masterId: 'nails' },
        { id: 'svc-2', durationMin: 30, masterId: 'brows' },
      ],
    });

    expect(getAvailableSlots).toHaveBeenCalledTimes(2);
    expect(getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        masterId: 'nails',
        services: [{ id: 'svc-1', durationMin: 115 }],
      }),
    );
    expect(getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        masterId: 'brows',
        services: [{ id: 'svc-2', durationMin: 30 }],
      }),
    );
    expect(text).toContain('12:00');
    expect(text).not.toContain('13:00');
    expect(text).toMatch(/services\[\]\.master_id/);
    expect(text).toContain('[master_id=nails] Анна');
    expect(text).toContain('[master_id=brows] Оля');
  });
});
