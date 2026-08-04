import { describe, expect, it } from 'vitest';
import {
  assertFreeTimePayload,
  buildFreeTimeQueryParams,
  invertFreeTime,
  parseAgentDate,
  resolveFreeTimeDurationMin,
  resolveFreeTimeStep,
} from './beautypro-free-time.js';

describe('beautypro free_time helpers', () => {
  it('parses DD.MM.YYYY and ISO dates', () => {
    expect(parseAgentDate('05.08.2026')).toEqual({ d: 5, m: 8, y: 2026 });
    expect(parseAgentDate('2026-08-05')).toEqual({ y: 2026, m: 8, d: 5 });
    expect(parseAgentDate('nope')).toBeNull();
  });

  it('maps duration to allowed step values (not auto)', () => {
    expect(resolveFreeTimeStep(30)).toBe('15m');
    expect(resolveFreeTimeStep(60)).toBe('30m');
    expect(resolveFreeTimeStep(90)).toBe('30m');
    expect(resolveFreeTimeStep(120)).toBe('60m');
  });

  it('builds day query with nearest_day_only=false and services', () => {
    const params = buildFreeTimeQueryParams(
      {
        date: '05.08.2026',
        branchId: 'loc-1',
        services: [{ id: 'svc-1', durationMin: 90 }],
      },
      { nearestDayOnly: false, publicEmployees: true, includeServices: true },
    );

    expect(params.nearest_day_only).toBe(false);
    expect(params.public_employees).toBe(true);
    expect(params.location).toBe('loc-1');
    expect(params.services).toBe('svc-1');
    expect(params.duration).toBe(90);
    expect(params.step).toBe('30m');
    expect(params.step).not.toBe('auto');
    expect(String(params.from)).toContain('2026-08-05');
    expect(String(params.to)).toContain('2026-08-05');
  });

  it('passes professionals when masterId set and can omit services', () => {
    const params = buildFreeTimeQueryParams(
      {
        date: '05.08.2026',
        branchId: 'loc-1',
        services: [{ id: 'svc-1', durationMin: 90 }],
        masterId: 'master-9',
      },
      { includeServices: false },
    );

    expect(params.services).toBeUndefined();
    expect(params.professionals).toBe('master-9');
    expect(params.duration).toBe(90);
    expect(params.public_employees).toBeUndefined();
  });

  it('inverts free_time payload and skips malformed rows', () => {
    const { slots, masterIds } = invertFreeTime({
      'master-a': { '2026-08-05': ['10:00', '11:00'] },
      'master-b': { '2026-08-05': ['10:00'] },
      'master-bad': 'nope' as unknown as Record<string, string[]>,
    });

    expect([...masterIds].sort()).toEqual(['master-a', 'master-b']);
    expect(slots['2026-08-05']).toEqual([
      { date: '2026-08-05', time: '10:00', masterIds: ['master-a', 'master-b'] },
      { date: '2026-08-05', time: '11:00', masterIds: ['master-a'] },
    ]);
  });

  it('rejects soft-error free_time bodies', () => {
    expect(() =>
      assertFreeTimePayload({ message: 'Bad service', code: 'INVALID' }),
    ).toThrow(/Bad service/);
    expect(assertFreeTimePayload({})).toEqual({});
  });

  it('resolves duration safely', () => {
    expect(resolveFreeTimeDurationMin([{ id: 'a', durationMin: 45 }])).toBe(45);
    expect(resolveFreeTimeDurationMin([{ id: 'a', durationMin: NaN }])).toBe(60);
    expect(resolveFreeTimeDurationMin([])).toBe(60);
  });
});
