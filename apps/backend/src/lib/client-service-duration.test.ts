import { describe, expect, it } from 'vitest';
import type { CrmVisitHistoryItem } from '../services/crm/types.js';
import {
  computeActualDurationMin,
  effectiveVisitDurationMin,
  resolveRecommendedDuration,
} from './client-service-duration.js';

function visit(
  partial: Partial<CrmVisitHistoryItem> & { id: string; date: string },
): CrmVisitHistoryItem {
  return {
    durationMin: 60,
    items: [{ name: 'Комплекс', type: 'Service', id: 'svc-complex' }],
    ...partial,
  };
}

describe('computeActualDurationMin', () => {
  it('computes wall-clock minutes from start to sale', () => {
    expect(
      computeActualDurationMin(
        '2026-07-17T11:00:00.000Z',
        '2026-07-17T12:11:00.000Z',
      ),
    ).toBe(71);
  });

  it('rejects invalid / outlier deltas', () => {
    expect(
      computeActualDurationMin(
        '2026-07-17T11:00:00.000Z',
        '2026-07-17T11:05:00.000Z',
      ),
    ).toBeNull();
    expect(
      computeActualDurationMin(
        '2026-07-17T11:00:00.000Z',
        '2026-07-17T18:00:00.000Z',
      ),
    ).toBeNull();
    expect(computeActualDurationMin('bad', 'also-bad')).toBeNull();
  });
});

describe('effectiveVisitDurationMin', () => {
  it('prefers actual over booked', () => {
    expect(
      effectiveVisitDurationMin(
        visit({
          id: '1',
          date: '2026-07-17T11:00:00.000Z',
          bookedDurationMin: 60,
          actualDurationMin: 71,
          durationMin: 60,
        }),
      ),
    ).toBe(71);
  });

  it('falls back to booked then durationMin', () => {
    expect(
      effectiveVisitDurationMin(
        visit({
          id: '1',
          date: '2026-07-17T11:00:00.000Z',
          bookedDurationMin: 90,
          durationMin: 60,
        }),
      ),
    ).toBe(90);
    expect(
      effectiveVisitDurationMin(
        visit({
          id: '1',
          date: '2026-07-17T11:00:00.000Z',
          durationMin: 55,
        }),
      ),
    ).toBe(55);
  });
});

describe('resolveRecommendedDuration', () => {
  it('returns catalog when no matching visits', () => {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceName: 'Комплекс',
      visits: [],
    });
    expect(rec.source).toBe('catalog');
    expect(rec.durationMin).toBe(60);
    expect(rec.sampleCount).toBe(0);
  });

  it('matches by service id and uses actual median', () => {
    const visits = [
      visit({
        id: 'a',
        date: '2026-07-17T11:00:00.000Z',
        bookedDurationMin: 60,
        actualDurationMin: 71,
        durationMin: 60,
        paid: true,
        items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
      }),
      visit({
        id: 'b',
        date: '2026-06-10T11:00:00.000Z',
        bookedDurationMin: 60,
        actualDurationMin: 75,
        durationMin: 60,
        paid: true,
        items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
      }),
      visit({
        id: 'c',
        date: '2026-05-01T11:00:00.000Z',
        bookedDurationMin: 60,
        actualDurationMin: 70,
        durationMin: 60,
        paid: true,
        items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
      }),
    ];
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceId: 'svc-complex',
      visits,
    });
    expect(rec.source).toBe('history_actual');
    expect(rec.sampleCount).toBe(3);
    expect(rec.durationMin).toBe(70);
    expect(rec.durationMin).toBeGreaterThan(60);
  });

  it('matches by name token overlap', () => {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceName: 'комплекс жіночий',
      visits: [
        visit({
          id: '1',
          date: '2026-07-01T10:00:00.000Z',
          actualDurationMin: 90,
          durationMin: 60,
          paid: true,
          items: [{ name: 'Комплекс', type: 'Service' }],
        }),
      ],
    });
    expect(rec.source).toBe('history_actual');
    expect(rec.durationMin).toBe(90);
  });

  it('ignores unrelated services', () => {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceName: 'Манікюр',
      visits: [
        visit({
          id: '1',
          date: '2026-07-01T10:00:00.000Z',
          actualDurationMin: 90,
          durationMin: 60,
          items: [{ name: 'Стрижка', type: 'Service' }],
        }),
      ],
    });
    expect(rec.source).toBe('catalog');
    expect(rec.durationMin).toBe(60);
  });

  it('clamps extreme history vs catalog', () => {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceId: 'svc-complex',
      visits: [
        visit({
          id: '1',
          date: '2026-07-01T10:00:00.000Z',
          actualDurationMin: 200,
          durationMin: 60,
          paid: true,
          items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
        }),
      ],
    });
    // catalog*2 = 120
    expect(rec.durationMin).toBeLessThanOrEqual(120);
    expect(rec.durationMin).toBeGreaterThanOrEqual(15);
  });

  it('prefers same master samples', () => {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceId: 'svc-complex',
      masterId: 'olesya',
      visits: [
        visit({
          id: 'other',
          date: '2026-07-20T10:00:00.000Z',
          actualDurationMin: 120,
          durationMin: 60,
          paid: true,
          professionalId: 'other-pro',
          items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
        }),
        visit({
          id: 'same',
          date: '2026-07-10T10:00:00.000Z',
          actualDurationMin: 75,
          durationMin: 60,
          paid: true,
          professionalId: 'olesya',
          items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
        }),
      ],
    });
    // same-master ranked first; with 2 samples median of [75, 120] after rank = [75, 120]
    // rank puts same master first, then other → median 75+120 / 2 = 98 → round step
    expect(rec.sampleCount).toBe(2);
    expect(rec.source).toBe('history_actual');
  });

  it('uses booked when no actual', () => {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: 60,
      serviceId: 'svc-complex',
      visits: [
        visit({
          id: '1',
          date: '2026-07-01T10:00:00.000Z',
          bookedDurationMin: 90,
          durationMin: 90,
          paid: true,
          items: [{ id: 'svc-complex', name: 'Комплекс', type: 'Service' }],
        }),
      ],
    });
    expect(rec.source).toBe('history_booked');
    expect(rec.durationMin).toBe(90);
  });
});
