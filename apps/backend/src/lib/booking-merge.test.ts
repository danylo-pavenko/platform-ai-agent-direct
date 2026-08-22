import { describe, expect, it } from 'vitest';
import {
  appointmentServiceKey,
  buildBookingOrderSummary,
  mergeAppointmentServiceLines,
  mergeOrderLineItems,
} from './booking-merge.js';

describe('booking-merge', () => {
  it('dedupes appointment lines by service id + master', () => {
    const existing = [
      { id: 'svc-1', durationMin: 60, masterId: 'm-1', name: 'Манікюр' },
    ];
    const incoming = [
      { id: 'svc-1', durationMin: 60, masterId: 'm-1', name: 'Манікюр' },
      { id: 'svc-2', durationMin: 30, masterId: 'm-2', name: 'Брови' },
    ];
    const { merged, added } = mergeAppointmentServiceLines(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe('svc-2');
  });

  it('allows same service with different masters', () => {
    const keyA = appointmentServiceKey({
      id: 'svc-1',
      durationMin: 60,
      masterId: 'm-1',
    });
    const keyB = appointmentServiceKey({
      id: 'svc-1',
      durationMin: 60,
      masterId: 'm-2',
    });
    expect(keyA).not.toBe(keyB);
  });

  it('merges order items by name', () => {
    const merged = mergeOrderLineItems(
      [{ name: 'Манікюр', price: 820, qty: 1 }],
      [
        { name: 'манікюр', price: 820, qty: 1 },
        { name: 'Брови', price: 350, qty: 1 },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.name)).toEqual(['Манікюр', 'Брови']);
  });

  it('builds booking order summary', () => {
    expect(
      buildBookingOrderSummary({
        serviceNames: ['Манікюр', 'Брови'],
        date: '08.08.2026',
        time: '11:00',
      }),
    ).toBe('Запис: Манікюр, Брови · 08.08.2026 11:00');
  });
});
