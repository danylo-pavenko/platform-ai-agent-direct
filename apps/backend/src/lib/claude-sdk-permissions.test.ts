import { describe, expect, it } from 'vitest';
import {
  evaluateSdkToolPermission,
  isRescheduleBookAttempt,
} from './claude-sdk-permissions.js';

const bookingAllow = new Set([
  'search_services',
  'get_available_slots',
  'book_appointment',
  'cancel_appointment',
  'remove_appointment_service',
  'reschedule_appointment',
  'request_handoff',
  'update_client_info',
]);

const salesAllow = new Set(['search_catalog', 'collect_order', 'create_local_order']);

function bookArgs(over: Record<string, unknown> = {}) {
  return {
    customer_name: 'Іван',
    phone: '+380991112233',
    date: '21.08.2026',
    time: '10:00',
    services: [{ id: 'svc-1', name: 'Манікюр', duration_min: 60 }],
    ...over,
  };
}

describe('evaluateSdkToolPermission', () => {
  it('always allows request_handoff', () => {
    const r = evaluateSdkToolPermission(
      'mcp__platform__request_handoff',
      { reason: 'скасуйте запис' },
      { allowNames: bookingAllow },
    );
    expect(r.behavior).toBe('allow');
  });

  it('allows lookup tools', () => {
    const r = evaluateSdkToolPermission(
      'search_services',
      { query: 'манікюр' },
      { allowNames: bookingAllow },
    );
    expect(r.behavior).toBe('allow');
  });

  it('denies Bash even if somehow named', () => {
    const r = evaluateSdkToolPermission('Bash', { command: 'ls' }, { allowNames: new Set(['Bash']) });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toMatch(/Coding tools/);
  });

  it('denies book_appointment with incomplete args', () => {
    const r = evaluateSdkToolPermission(
      'book_appointment',
      { date: '21.08.2026', time: '10:00' },
      { allowNames: bookingAllow },
    );
    expect(r.behavior).toBe('deny');
  });

  it('denies force=true on book_appointment', () => {
    const r = evaluateSdkToolPermission(
      'book_appointment',
      bookArgs({ force: true }),
      { allowNames: bookingAllow },
    );
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toMatch(/force/);
  });

  it('denies a second book as reschedule when date/time differ', () => {
    const r = evaluateSdkToolPermission('book_appointment', bookArgs({ date: '22.08.2026' }), {
      allowNames: bookingAllow,
      existingBooking: { date: '21.08.2026', time: '10:00' },
    });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toMatch(/reschedule_appointment/);
  });

  it('allows reschedule_appointment with date and time', () => {
    const r = evaluateSdkToolPermission(
      'reschedule_appointment',
      { date: '22.08.2026', time: '11:00' },
      { allowNames: bookingAllow, existingBooking: { date: '21.08.2026', time: '10:00' } },
    );
    expect(r.behavior).toBe('allow');
  });

  it('allows cancel_appointment', () => {
    const r = evaluateSdkToolPermission(
      'cancel_appointment',
      { reason: 'клієнт просить' },
      { allowNames: bookingAllow },
    );
    expect(r.behavior).toBe('allow');
  });

  it('denies remove_appointment_service without service id/name', () => {
    const r = evaluateSdkToolPermission(
      'remove_appointment_service',
      {},
      { allowNames: bookingAllow },
    );
    expect(r.behavior).toBe('deny');
  });

  it('allows book retry on the same date+time (merge / idempotent)', () => {
    const r = evaluateSdkToolPermission('book_appointment', bookArgs(), {
      allowNames: bookingAllow,
      existingBooking: { date: '21.08.2026', time: '10:00' },
    });
    expect(r.behavior).toBe('allow');
  });

  it('denies collect_order without delivery fields', () => {
    const r = evaluateSdkToolPermission(
      'collect_order',
      { items: [{ name: 'Худі', price: 900 }] },
      { allowNames: salesAllow },
    );
    expect(r.behavior).toBe('deny');
  });

  it('allows complete collect_order', () => {
    const r = evaluateSdkToolPermission(
      'collect_order',
      {
        items: [{ name: 'Худі', price: 900 }],
        customer_name: 'Іра',
        phone: '+38099',
        city: 'Київ',
        np_branch: '12',
        payment_method: 'cod',
      },
      { allowNames: salesAllow },
    );
    expect(r.behavior).toBe('allow');
  });

  it('denies mutations after a terminal tool already ran this turn', () => {
    const r = evaluateSdkToolPermission('book_appointment', bookArgs(), {
      allowNames: bookingAllow,
      mutationsAllowed: false,
    });
    expect(r.behavior).toBe('deny');
  });

  it('still allows handoff when mutations are disabled', () => {
    const r = evaluateSdkToolPermission(
      'request_handoff',
      { reason: 'скарга' },
      { allowNames: bookingAllow, mutationsAllowed: false },
    );
    expect(r.behavior).toBe('allow');
  });
});

describe('isRescheduleBookAttempt', () => {
  it('treats ISO vs UA date as the same day', () => {
    expect(
      isRescheduleBookAttempt(
        { date: '2026-08-21', time: '10:00' },
        { date: '21.08.2026', time: '10:00' },
      ),
    ).toBe(false);
  });
});
