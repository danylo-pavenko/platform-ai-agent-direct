import { describe, expect, it } from 'vitest';
import {
  buildDisambiguatedMasterMap,
  disambiguateMasterDisplayName,
  findUnavailableMasterAssignments,
  formatMasterServiceMismatchToolResult,
} from './master-service-fit.js';
import type { CrmEmployee, CrmServiceItem } from '../services/crm/types.js';

describe('disambiguateMasterDisplayName', () => {
  it('keeps plain name when unique', () => {
    expect(
      disambiguateMasterDisplayName('a', 'Оля', [
        { id: 'a', name: 'Оля' },
        { id: 'b', name: 'Анна' },
      ]),
    ).toBe('Оля');
  });

  it('appends positions when two share a name', () => {
    const peers = [
      { id: 'nails', name: 'Анастасія', positionNames: ['Манікюр'] },
      { id: 'hair', name: 'Анастасія', positionNames: ['Перукар'] },
    ];
    expect(disambiguateMasterDisplayName('nails', 'Анастасія', peers)).toBe(
      'Анастасія (Манікюр)',
    );
    expect(disambiguateMasterDisplayName('hair', 'Анастасія', peers)).toBe(
      'Анастасія (Перукар)',
    );
  });

  it('falls back to short id when duplicate names lack positions', () => {
    const peers = [
      { id: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'Анастасія' },
      { id: 'bbbbbbbb-2222-2222-2222-222222222222', name: 'Анастасія' },
    ];
    expect(disambiguateMasterDisplayName(peers[0]!.id, 'Анастасія', peers)).toBe(
      'Анастасія [#aaaaaaaa]',
    );
  });
});

describe('buildDisambiguatedMasterMap', () => {
  it('maps every id to a disambiguated label', () => {
    const map = buildDisambiguatedMasterMap([
      { id: '1', name: 'Анастасія', positionNames: ['Нігті'] },
      { id: '2', name: 'Анастасія', positionNames: ['Волосся'] },
    ]);
    expect(map.get('1')).toBe('Анастасія (Нігті)');
    expect(map.get('2')).toBe('Анастасія (Волосся)');
  });
});

describe('findUnavailableMasterAssignments', () => {
  const employees: CrmEmployee[] = [
    {
      id: 'nails-pro',
      name: 'Анастасія',
      positionIds: ['pos-nails'],
      positionNames: ['Манікюр'],
    },
    {
      id: 'hair-pro',
      name: 'Анастасія',
      positionIds: ['pos-hair'],
      positionNames: ['Перукар'],
    },
  ];

  const hairService: CrmServiceItem = {
    id: 'svc-tone',
    name: 'Тонування',
    price: 800,
    durationMin: 90,
    priceRows: [
      { branchId: 'loc-1', positionId: 'pos-hair', positionName: 'Перукар', price: 800 },
    ],
  };

  it('flags manicure master booked onto hair service', () => {
    const bad = findUnavailableMasterAssignments({
      services: [{ id: 'svc-tone', name: 'Тонування', masterId: 'nails-pro' }],
      employees,
      catalog: [hairService],
      branchId: 'loc-1',
    });
    expect(bad).toHaveLength(1);
    expect(bad[0]?.masterId).toBe('nails-pro');
    expect(bad[0]?.serviceId).toBe('svc-tone');
  });

  it('allows hair master on hair service', () => {
    const ok = findUnavailableMasterAssignments({
      services: [{ id: 'svc-tone', name: 'Тонування', masterId: 'hair-pro' }],
      employees,
      catalog: [hairService],
      branchId: 'loc-1',
    });
    expect(ok).toHaveLength(0);
  });

  it('skips when master has no positionIds (cannot prove mismatch)', () => {
    const ok = findUnavailableMasterAssignments({
      services: [{ id: 'svc-tone', masterId: 'unknown-pro' }],
      employees: [{ id: 'unknown-pro', name: 'Хтось' }],
      catalog: [hairService],
      branchId: 'loc-1',
    });
    expect(ok).toHaveLength(0);
  });
});

describe('formatMasterServiceMismatchToolResult', () => {
  it('includes recovery instructions for the model', () => {
    const text = formatMasterServiceMismatchToolResult([
      {
        serviceId: 'svc-1',
        serviceName: 'Тонування',
        masterId: 'nails',
        masterName: 'Анастасія (Манікюр)',
        reason: 'немає ціни',
      },
    ]);
    expect(text).toContain('MASTER_SERVICE_MISMATCH');
    expect(text).toContain('get_available_slots');
    expect(text).toContain('Анастасія (Манікюр)');
  });
});
