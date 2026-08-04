import { describe, expect, it } from 'vitest';
import { filterSlotsByMasterId } from './slot-filter.js';
import type { CrmSlot } from './types.js';

function slot(time: string, masterIds: string[]): CrmSlot {
  return { date: '2026-08-04', time, masterIds };
}

describe('filterSlotsByMasterId', () => {
  const masters = [
    { id: 'm1', name: 'Anna' },
    { id: 'm2', name: 'Bohdan' },
  ];
  const slots = {
    '2026-08-04': [
      slot('10:00', ['m1', 'm2']),
      slot('11:00', ['m2']),
      slot('12:00', ['m1']),
    ],
  };

  it('returns input unchanged when masterId is missing', () => {
    const result = filterSlotsByMasterId({ slots, masters }, undefined);
    expect(result).toEqual({ slots, masters });
  });

  it('keeps only slots for the given master and narrows masterIds', () => {
    const result = filterSlotsByMasterId({ slots, masters }, 'm1');
    expect(result.masters).toEqual([{ id: 'm1', name: 'Anna' }]);
    expect(result.slots['2026-08-04']).toEqual([
      slot('10:00', ['m1']),
      slot('12:00', ['m1']),
    ]);
  });

  it('returns empty slots when master has no availability', () => {
    const result = filterSlotsByMasterId({ slots, masters }, 'm-missing');
    expect(result.slots).toEqual({});
    expect(result.masters).toEqual([]);
  });
});
