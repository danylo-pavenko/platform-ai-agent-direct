import { describe, expect, it } from 'vitest';
import { inferOpenAgendaFromRules } from './open-agenda-rules.js';

describe('inferOpenAgendaFromRules', () => {
  it('extracts Sofiya-like booking thread', () => {
    const agenda = inferOpenAgendaFromRules([
      {
        direction: 'in',
        sender: 'client',
        text: 'на коли є години в понеділок на манікюр?)',
        createdAt: new Date('2026-09-26T19:25:00.000Z'),
      },
      {
        direction: 'out',
        sender: 'manager',
        text: 'На понеділок є вікна до Надії: 13:00, 14:00, 15:00',
        createdAt: new Date('2026-09-26T19:25:30.000Z'),
      },
      {
        direction: 'in',
        sender: 'client',
        text: 'давайте до Надії на 14:00 комплекс',
        createdAt: new Date('2026-09-26T19:27:00.000Z'),
      },
    ]);
    expect(agenda).not.toBeNull();
    expect(agenda!.kind).toBe('booking');
    expect(agenda!.knownFacts.some((f) => f.includes('14:00'))).toBe(true);
    expect(agenda!.knownFacts.some((f) => /Надія/i.test(f))).toBe(true);
    expect(agenda!.knownFacts.some((f) => /комплекс/i.test(f))).toBe(true);
  });

  it('returns null for smalltalk', () => {
    expect(
      inferOpenAgendaFromRules([
        {
          direction: 'in',
          sender: 'client',
          text: 'добрий день!',
          createdAt: new Date(),
        },
      ]),
    ).toBeNull();
  });
});
