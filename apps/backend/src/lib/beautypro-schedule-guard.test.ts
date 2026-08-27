import { describe, expect, it } from 'vitest';
import {
  evaluateAnyMasterFreeTimeStatus,
  evaluateMasterFreeTimeStatus,
  formatMasterScheduleMismatchToolResult,
  freeTimeDayKeysFor,
} from './beautypro-schedule-guard.js';
import type { CrmSlot } from '../services/crm/types.js';

function slots(
  day: string,
  rows: Array<{ time: string; masterIds: string[] }>,
): Record<string, CrmSlot[]> {
  return {
    [day]: rows.map((r) => ({ date: day, time: r.time, masterIds: r.masterIds })),
  };
}

describe('freeTimeDayKeysFor', () => {
  it('returns both UA and ISO keys', () => {
    expect(freeTimeDayKeysFor('05.08.2026')).toEqual(
      expect.arrayContaining(['05.08.2026', '2026-08-05']),
    );
  });
});

describe('evaluateMasterFreeTimeStatus', () => {
  it('flags day_closed when master has no slots that day', () => {
    const status = evaluateMasterFreeTimeStatus({
      slots: slots('2026-08-05', [{ time: '10:00', masterIds: ['other'] }]),
      masterId: 'nails',
      date: '05.08.2026',
      time: '10:00',
    });
    expect(status).toBe('day_closed');
  });

  it('flags slot_unavailable when day open but time missing', () => {
    const status = evaluateMasterFreeTimeStatus({
      slots: slots('2026-08-05', [{ time: '10:00', masterIds: ['nails'] }]),
      masterId: 'nails',
      date: '05.08.2026',
      time: '14:00',
    });
    expect(status).toBe('slot_unavailable');
  });

  it('accepts matching time on ISO day key', () => {
    const status = evaluateMasterFreeTimeStatus({
      slots: slots('2026-08-05', [{ time: '14:00', masterIds: ['nails'] }]),
      masterId: 'nails',
      date: '05.08.2026',
      time: '14:00',
    });
    expect(status).toBe('ok');
  });
});

describe('evaluateAnyMasterFreeTimeStatus', () => {
  it('flags day_closed when nobody has slots', () => {
    expect(
      evaluateAnyMasterFreeTimeStatus({
        slots: {},
        date: '05.08.2026',
        time: '10:00',
      }),
    ).toBe('day_closed');
  });
});

describe('formatMasterScheduleMismatchToolResult', () => {
  it('mentions MASTER_DAY_CLOSED recovery', () => {
    const text = formatMasterScheduleMismatchToolResult({
      status: 'day_closed',
      masterId: 'pro-1',
      date: '05.08.2026',
      time: '10:00',
    });
    expect(text).toContain('MASTER_DAY_CLOSED');
    expect(text).toContain('get_available_slots');
  });
});
