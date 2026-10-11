import { describe, expect, it } from 'vitest';
import { bookingVisitsCanMerge } from './booking-visit-merge.js';

describe('bookingVisitsCanMerge', () => {
  it('keeps BeautyPro services on one visit', () => {
    expect(
      bookingVisitsCanMerge('beautypro', [{ masterId: 'a' }], [{ masterId: 'b' }]),
    ).toBe(true);
  });

  it('opens a new Altegio visit when the master differs', () => {
    expect(
      bookingVisitsCanMerge('altegio', [{ masterId: '7' }], [{ masterId: '8' }]),
    ).toBe(false);
  });

  it('adds another service of the same Altegio master to the visit', () => {
    expect(
      bookingVisitsCanMerge(
        'altegio',
        [{ masterId: '7' }],
        [{ masterId: '7' }, { masterId: '7' }],
      ),
    ).toBe(true);
  });
});
