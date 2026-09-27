import { describe, expect, it } from 'vitest';
import {
  formatPriorSessionDigestForPrompt,
  priorDigestAgeHeader,
} from './prior-session-digest.js';

describe('prior-session-digest', () => {
  it('labels yesterday vs older', () => {
    const oldest = new Date('2026-09-26T19:24:00.000Z');
    const newest = new Date('2026-09-26T19:28:00.000Z');
    const now = new Date('2026-09-26T22:27:00.000Z'); // 01:27 Kyiv next day
    expect(priorDigestAgeHeader(oldest, newest, now, 'Europe/Kyiv')).toMatch(/Вчора/);
  });

  it('formats digest with past-context rules', () => {
    const text = formatPriorSessionDigestForPrompt(
      [
        {
          direction: 'in',
          sender: 'client',
          text: 'на коли є години в понеділок на манікюр?)',
          createdAt: new Date('2026-09-26T19:25:00.000Z'),
        },
        {
          direction: 'out',
          sender: 'bot',
          text: 'На понеділок є вікна до Надії: 13:00, 14:00, 15:00',
          createdAt: new Date('2026-09-26T19:25:30.000Z'),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'давайте до Надії на 14:00',
          createdAt: new Date('2026-09-26T19:27:00.000Z'),
        },
      ],
      new Date('2026-09-26T22:27:00.000Z'),
      'Europe/Kyiv',
    );
    expect(text).toMatch(/Попередня переписка/);
    expect(text).toContain('Надії');
    expect(text).toMatch(/МИНУЛЕ/);
    expect(text).toMatch(/Незавершений запис/);
  });

  it('returns empty for blank messages', () => {
    expect(
      formatPriorSessionDigestForPrompt(
        [{ direction: 'in', sender: 'client', text: '  ', createdAt: new Date() }],
        new Date(),
        'Europe/Kyiv',
      ),
    ).toBe('');
  });
});
