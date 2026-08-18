import { describe, expect, it } from 'vitest';
import {
  broadenServiceQueries,
  formatSearchServicesToolResult,
  parseGetAvailableSlotsArgs,
} from '../lib/booking-lookup-format.js';

describe('broadenServiceQueries', () => {
  it('extracts manicure keyword from long gendered phrase', () => {
    const alts = broadenServiceQueries('чоловічий манікюр без покриття');
    expect(alts).toContain('манікюр');
  });

  it('returns empty for blank', () => {
    expect(broadenServiceQueries('  ')).toEqual([]);
  });
});

describe('formatSearchServicesToolResult', () => {
  it('forbids inventing prices on empty result', () => {
    const msg = formatSearchServicesToolResult({
      query: 'чоловічий манікюр без покриття',
      matchCount: 0,
      contextBlock: '',
      usedQuery: 'чоловічий манікюр без покриття',
    });
    expect(msg).toMatch(/НЕ вигадуй/i);
    expect(msg).toMatch(/get_available_slots не викликай/);
  });

  it('nudges slots after successful search', () => {
    const msg = formatSearchServicesToolResult({
      query: 'манікюр',
      matchCount: 1,
      contextBlock: '[service_id=1] Чистка | 60 хв | від 850 ₴',
      usedQuery: 'манікюр',
    });
    expect(msg).toContain('get_available_slots');
    expect(msg).toContain('РЕЗУЛЬТАТ');
  });

  it('explains broadened query', () => {
    const msg = formatSearchServicesToolResult({
      query: 'чоловічий манікюр',
      matchCount: 2,
      contextBlock: 'line',
      usedQuery: 'манікюр',
      broadenedFrom: 'чоловічий манікюр',
    });
    expect(msg).toContain('чоловічий манікюр');
    expect(msg).toContain('манікюр');
  });
});

describe('parseGetAvailableSlotsArgs', () => {
  it('parses valid args', () => {
    const parsed = parseGetAvailableSlotsArgs({
      date: '07.08.2026',
      services: [{ id: 'abc', duration_min: 60 }],
    });
    expect(parsed).toEqual({
      date: '07.08.2026',
      services: [{ id: 'abc', durationMin: 60 }],
      fullMonth: false,
      masterId: undefined,
    });
  });

  it('parses per-service master_id', () => {
    const parsed = parseGetAvailableSlotsArgs({
      date: '21.08.2026',
      services: [
        { id: 'svc-1', duration_min: 115, master_id: 'nails' },
        { id: 'svc-2', duration_min: 30, master_id: 'brows' },
      ],
    });
    expect(parsed).toMatchObject({
      date: '21.08.2026',
      services: [
        { id: 'svc-1', durationMin: 115, masterId: 'nails' },
        { id: 'svc-2', durationMin: 30, masterId: 'brows' },
      ],
    });
  });

  it('rejects missing services', () => {
    const parsed = parseGetAvailableSlotsArgs({ date: '07.08.2026', services: [] });
    expect(parsed).toHaveProperty('error');
  });
});
