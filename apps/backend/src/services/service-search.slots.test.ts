import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCrmProvider, getCrmAdapter, getAvailableSlots } = vi.hoisted(() => ({
  resolveCrmProvider: vi.fn(),
  getCrmAdapter: vi.fn(),
  getAvailableSlots: vi.fn(),
}));

vi.mock('../lib/crm-routing.js', () => ({ resolveCrmProvider }));
vi.mock('./crm/index.js', () => ({ getCrmAdapter }));

import { getAvailableSlotsForContext } from './service-search.js';

describe('getAvailableSlotsForContext preferred master', () => {
  beforeEach(() => {
    resolveCrmProvider.mockReset();
    getCrmAdapter.mockReset();
    getAvailableSlots.mockReset();
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
});
