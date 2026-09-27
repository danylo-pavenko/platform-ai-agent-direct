import { describe, expect, it } from 'vitest';
import {
  agendaFromBookingFunnel,
  factValue,
  formatOpenAgendaForPrompt,
  freshOpenAgenda,
  hasOpenAgendaInferAttempt,
  isFreshOpenAgenda,
  openAgendaInferEmptyMarker,
  parseOpenAgenda,
  type OpenAgenda,
} from './open-agenda.js';

const base: OpenAgenda = {
  kind: 'booking',
  summary: 'Клієнт хоче комплекс до Надії на 14:00',
  knownFacts: ['послуга: комплекс', 'майстер: Надія', 'час: 14:00', 'дата: 29.09.2026'],
  nextAction: 'Взяти імʼя/телефон і book',
  awaiting: ['name', 'phone'],
  status: 'open',
  source: 'ig_import',
  confidence: 'high',
  updatedAt: new Date().toISOString(),
};

describe('open-agenda', () => {
  it('parses and stays fresh within TTL', () => {
    expect(parseOpenAgenda(base)?.summary).toContain('комплекс');
    expect(isFreshOpenAgenda(base)).toBe(true);
    expect(freshOpenAgenda(base)).not.toBeNull();
  });

  it('rejects done / empty / expired', () => {
    expect(isFreshOpenAgenda({ ...base, status: 'done' })).toBe(false);
    expect(isFreshOpenAgenda({ ...base, summary: '', knownFacts: [] })).toBe(false);
    expect(
      isFreshOpenAgenda({
        ...base,
        updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ).toBe(false);
  });

  it('formats prompt with open-thread rules', () => {
    const text = formatOpenAgendaForPrompt(base, new Date(), 'Europe/Kyiv');
    expect(text).toMatch(/Відкритий тред/);
    expect(text).toContain('Надія');
    expect(text).toMatch(/Незавершений запис/);
  });

  it('tracks infer attempt marker', () => {
    const marker = openAgendaInferEmptyMarker('ig_import');
    expect(hasOpenAgendaInferAttempt(marker)).toBe(true);
    expect(freshOpenAgenda(marker)).toBeNull();
  });

  it('builds agenda from booking funnel', () => {
    const a = agendaFromBookingFunnel({
      status: 'awaiting_contact',
      date: '29.09.2026',
      time: '14:00',
      masterName: 'Надія',
      services: [{ id: 'svc-1', durationMin: 90, name: 'Комплекс' }],
      missing: ['name', 'phone'],
      updatedAt: new Date().toISOString(),
    });
    expect(a.kind).toBe('booking');
    expect(factValue(a.knownFacts, 'час')).toBe('14:00');
    expect(a.awaiting).toContain('name');
  });
});
