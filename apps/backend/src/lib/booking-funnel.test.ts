import { describe, expect, it } from 'vitest';
import {
  applyTimeSelectionFromClientText,
  BOOKING_FUNNEL_TTL_MS,
  formatBookingFunnelForPrompt,
  funnelAgeLabel,
  funnelFromBookArgs,
  funnelFromSlotOffer,
  isFreshBookingFunnel,
  parseBookingFunnel,
  type BookingFunnel,
} from './booking-funnel.js';
import type { BookingSlotOffer } from './booking-slot-offer.js';

const offer: BookingSlotOffer = {
  date: '28.09.2026',
  fetchedAt: new Date().toISOString(),
  days: [
    {
      date: '28.09.2026',
      times: ['13:00', '14:00', '15:00'],
      slots: [
        { time: '13:00', masterIds: ['m-nadia'] },
        { time: '14:00', masterIds: ['m-nadia'] },
        { time: '15:00', masterIds: ['m-nadia'] },
      ],
    },
  ],
  services: [
    {
      id: 'svc-complex',
      durationMin: 115,
      name: 'Комплекс манікюр',
    },
  ],
  masterIds: ['m-nadia'],
  masters: [{ id: 'm-nadia', name: 'Надія' }],
};

describe('booking-funnel', () => {
  it('parses and expires after TTL', () => {
    const funnel = funnelFromSlotOffer(offer, null);
    expect(isFreshBookingFunnel(funnel)).toBe(true);
    expect(parseBookingFunnel(funnel)?.services[0]?.id).toBe('svc-complex');
    const stale: BookingFunnel = {
      ...funnel,
      updatedAt: new Date(Date.now() - BOOKING_FUNNEL_TTL_MS - 1000).toISOString(),
    };
    expect(isFreshBookingFunnel(stale)).toBe(false);
  });

  it('selects time from client text against offer', () => {
    const base = funnelFromSlotOffer(offer, null);
    const next = applyTimeSelectionFromClientText({
      text: 'давайте до Надії на 14:00',
      offer,
      funnel: base,
    });
    expect(next?.status).toBe('awaiting_contact');
    expect(next?.time).toBe('14:00');
    expect(next?.masterId).toBe('m-nadia');
    expect(next?.masterName).toBe('Надія');
  });

  it('builds awaiting_contact from book args', () => {
    const funnel = funnelFromBookArgs({
      date: '28.09.2026',
      time: '14:00',
      services: [{ id: 'svc-complex', durationMin: 115, name: 'Комплекс' }],
      masterId: 'm-nadia',
      masterName: 'Надія',
      missing: ['name', 'phone'],
    });
    expect(funnel.status).toBe('awaiting_contact');
    expect(funnel.time).toBe('14:00');
  });

  it('formats prompt with close instruction', () => {
    const funnel = funnelFromBookArgs({
      date: '28.09.2026',
      time: '14:00',
      services: [{ id: 'svc-complex', durationMin: 115, name: 'Комплекс манікюр' }],
      masterId: 'm-nadia',
      masterName: 'Надія',
      missing: ['name', 'phone'],
      now: new Date('2026-09-26T19:30:00.000Z'),
    });
    const text = formatBookingFunnelForPrompt(
      funnel,
      new Date('2026-09-26T22:30:00.000Z'),
      'Europe/Kyiv',
    );
    expect(text).toMatch(/Незавершений запис/);
    expect(text).toContain('14:00');
    expect(text).toContain('svc-complex');
    expect(text).toMatch(/book_appointment/);
    expect(text).toMatch(/НЕ search_services/);
  });

  it('labels overnight age as вчора', () => {
    const funnel = funnelFromBookArgs({
      date: '28.09.2026',
      time: '14:00',
      services: [{ id: 'x', durationMin: 60 }],
      missing: ['phone'],
      now: new Date('2026-09-26T19:30:00.000Z'),
    });
    expect(
      funnelAgeLabel(funnel, new Date('2026-09-27T01:27:00.000Z'), 'Europe/Kyiv'),
    ).toMatch(/вчора/);
  });
});
