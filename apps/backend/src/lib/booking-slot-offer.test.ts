import { describe, expect, it } from 'vitest';
import {
  BOOKING_SLOT_OFFER_TTL_MS,
  formatBookingSlotOfferForPrompt,
  isFreshBookingSlotOffer,
  parseBookingSlotOffer,
  pickSlotTimesForDay,
  preferTimesForDate,
  type BookingSlotOffer,
} from './booking-slot-offer.js';

const offer: BookingSlotOffer = {
  date: '19.09.2026',
  days: [{ date: '2026-09-19', times: ['10:00', '14:00', '16:00'] }],
  services: [{ id: 'svc-1', durationMin: 60, name: 'Стрижка' }],
  masterIds: ['m1'],
  fetchedAt: new Date('2026-09-19T10:00:00.000Z').toISOString(),
};

describe('parseBookingSlotOffer', () => {
  it('round-trips a valid offer and rejects junk', () => {
    expect(parseBookingSlotOffer(offer)?.days[0]?.times).toEqual(['10:00', '14:00', '16:00']);
    expect(parseBookingSlotOffer(null)).toBeNull();
    expect(parseBookingSlotOffer({ date: 'x' })).toBeNull();
  });
});

describe('isFreshBookingSlotOffer', () => {
  it('expires after TTL', () => {
    expect(isFreshBookingSlotOffer(offer, new Date('2026-09-19T11:00:00.000Z'))).toBe(true);
    expect(
      isFreshBookingSlotOffer(
        offer,
        new Date(new Date(offer.fetchedAt).getTime() + BOOKING_SLOT_OFFER_TTL_MS + 1),
      ),
    ).toBe(false);
  });
});

describe('formatBookingSlotOfferForPrompt', () => {
  it('tells the agent to book without a new slots lookup', () => {
    const text = formatBookingSlotOfferForPrompt(offer);
    expect(text).toContain('10:00, 14:00, 16:00');
    expect(text).toMatch(/БЕЗ нового get_available_slots/);
    expect(text).toContain('Стрижка');
  });
});

describe('pickSlotTimesForDay', () => {
  it('pins previously offered times that are still free', () => {
    const slots = [
      { time: '09:00' },
      { time: '10:00' },
      { time: '11:00' },
      { time: '14:00' },
      { time: '16:00' },
    ];
    const picked = pickSlotTimesForDay(slots, 3, ['16:00', '10:00']);
    expect(picked.map((s) => s.time)).toEqual(['16:00', '10:00', '09:00']);
  });
});

describe('preferTimesForDate', () => {
  it('matches the CRM day key', () => {
    expect(preferTimesForDate(offer, '2026-09-19')).toEqual(['10:00', '14:00', '16:00']);
    expect(preferTimesForDate(offer, '2026-09-20')).toBeUndefined();
  });
});
