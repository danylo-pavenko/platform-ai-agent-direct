import { describe, expect, it } from 'vitest';
import {
  formatLocalAuditTime,
  redactQuery,
  summarizeAuditBody,
} from './beautypro-api-audit.js';

describe('beautypro-api-audit helpers', () => {
  it('redacts secrets in query', () => {
    expect(
      redactQuery({
        application_id: 'app',
        application_secret: 'secret',
        database_code: '737532',
        refresh_token: 'tok',
      }),
    ).toEqual({
      application_id: 'app',
      application_secret: '[redacted]',
      database_code: '737532',
      refresh_token: '[redacted]',
    });
  });

  it('summarizes appointment body with service actions', () => {
    expect(
      summarizeAuditBody({
        state: 'planned',
        comments: 'x'.repeat(200),
        services: [
          { service: 's1', professional: 'p1', start: '10:00:00', duration: 60, action: 'insert' },
        ],
      }),
    ).toEqual({
      state: 'planned',
      comments: `${'x'.repeat(120)}…`,
      services: [
        {
          id: undefined,
          service: 's1',
          professional: 'p1',
          start: '10:00:00',
          duration: 60,
          action: 'insert',
        },
      ],
    });
  });

  it('formats local audit time in Europe/Kyiv', () => {
    // 2026-09-07T13:15:22.000Z = 16:15:22 in Kyiv (UTC+3, no DST that date)
    const s = formatLocalAuditTime(new Date('2026-09-07T13:15:22.000Z'), 'Europe/Kyiv');
    expect(s).toBe('2026-09-07 16:15:22');
  });
});
