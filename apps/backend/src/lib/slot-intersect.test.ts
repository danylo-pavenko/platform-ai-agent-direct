import { describe, expect, it } from 'vitest';
import { intersectSlotLookupResults } from './slot-intersect.js';

describe('intersectSlotLookupResults', () => {
  it('keeps only times present for every master', () => {
    const merged = intersectSlotLookupResults([
      {
        slots: {
          '21.08.2026': [
            { date: '21.08.2026', time: '12:00', masterIds: ['nails'] },
            { date: '21.08.2026', time: '13:00', masterIds: ['nails'] },
          ],
        },
        masters: [{ id: 'nails', name: 'Анна' }],
      },
      {
        slots: {
          '21.08.2026': [
            { date: '21.08.2026', time: '12:00', masterIds: ['brows'] },
            { date: '21.08.2026', time: '14:00', masterIds: ['brows'] },
          ],
        },
        masters: [{ id: 'brows', name: 'Оля' }],
      },
    ]);

    expect(merged.slots['21.08.2026']).toEqual([
      { date: '21.08.2026', time: '12:00', masterIds: ['nails', 'brows'] },
    ]);
    expect(merged.masters.map((m) => m.id).sort()).toEqual(['brows', 'nails']);
  });
});
