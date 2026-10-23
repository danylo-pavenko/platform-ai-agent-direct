import { describe, expect, it } from 'vitest';
import {
  isoDateToUaDate,
  pickSingleUpcomingCrm,
  resolveBookingTargetPreference,
  uaDateToIso,
} from './active-booking-resolve.js';

describe('active-booking-resolve', () => {
  const tz = 'Europe/Kyiv';
  // 2026-10-23 12:00 Kyiv (EEST = UTC+3)
  const now = new Date('2026-10-23T09:00:00.000Z');

  it('converts ISO ↔ UA dates', () => {
    expect(isoDateToUaDate('2026-10-23T13:15:00.000Z')).toBe('23.10.2026');
    expect(uaDateToIso('23.10.2026')).toBe('2026-10-23');
  });

  it('prefers conversation-local appointment', () => {
    const r = resolveBookingTargetPreference({
      conversationLocal: {
        id: 'local-1',
        conversationId: 'c1',
        scheduledDate: '23.10.2026',
        scheduledTime: '13:15',
        crmRecordId: 'crm-1',
      },
      clientLocals: [],
      crmBookings: [{ id: 'crm-2', date: '2026-10-24', time: '10:00' }],
      now,
      timeZone: tz,
    });
    expect(r).toEqual({ kind: 'local', appointmentId: 'local-1' });
  });

  it('falls back to sole CRM upcoming booking (manager Instagram case)', () => {
    const r = resolveBookingTargetPreference({
      conversationLocal: null,
      clientLocals: [],
      crmBookings: [
        {
          id: 'bp-visit',
          date: '2026-10-23',
          time: '13:15',
          serviceNames: ['Корекція брів', 'Фарбування'],
        },
      ],
      now,
      timeZone: tz,
    });
    expect(r).toEqual({
      kind: 'crm_only',
      crmRecordId: 'bp-visit',
      scheduledDate: '23.10.2026',
      scheduledTime: '13:15',
      serviceNames: ['Корекція брів', 'Фарбування'],
      locationId: undefined,
    });
  });

  it('marks multiple CRM bookings as ambiguous', () => {
    expect(
      pickSingleUpcomingCrm(
        [
          { id: 'a', date: '2026-10-23', time: '13:15' },
          { id: 'b', date: '2026-10-24', time: '11:00' },
        ],
        now,
        tz,
      ),
    ).toBe('ambiguous');
  });

  it('ignores past CRM bookings', () => {
    expect(
      pickSingleUpcomingCrm(
        [{ id: 'past', date: '2026-10-20', time: '13:15' }],
        now,
        tz,
      ),
    ).toBeNull();
  });
});
