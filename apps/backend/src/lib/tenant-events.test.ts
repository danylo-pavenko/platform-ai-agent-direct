import { describe, expect, it } from 'vitest';
import {
  defaultOnMatchForKind,
  eventVisibleForAgent,
  formatTenantEventsForPrompt,
  isRecentlyEnded,
  matchEventsByQuery,
  resolveEventLifecycle,
  scoreEventMatch,
  summaryFromDetails,
  type TenantEventFields,
} from './tenant-events.js';

function base(over: Partial<TenantEventFields> = {}): TenantEventFields {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Шукаємо SMM',
    kind: 'hiring',
    status: 'active',
    eventStartsAt: null,
    eventEndsAt: null,
    openFrom: null,
    openUntil: null,
    summary: 'Вакансія SMM / UGC',
    details: 'Шукаємо SMM. Передаємо керівнику.',
    keywords: ['smm', 'ugc', 'вакансія'],
    agentInstructions: 'Представся як Моксі і handoff.',
    onMatch: 'handoff',
    handoffReason: 'SMM vacancy',
    closedReplyHint: 'Вакансія вже закрита.',
    priority: 1,
    ...over,
  };
}

describe('tenant-events lifecycle', () => {
  it('defaults onMatch by kind', () => {
    expect(defaultOnMatchForKind('hiring')).toBe('handoff');
    expect(defaultOnMatchForKind('casting')).toBe('continue_funnel');
    expect(defaultOnMatchForKind('promo')).toBe('inform');
  });

  it('summaryFromDetails takes first sentence', () => {
    expect(summaryFromDetails('Перше речення. Друге.')).toBe('Перше речення.');
  });

  it('open / scheduled / expired / hidden', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(resolveEventLifecycle(base({ openFrom: null, openUntil: null }), now)).toBe('open');
    expect(
      resolveEventLifecycle(base({ openFrom: new Date('2026-10-27T00:00:00Z') }), now),
    ).toBe('scheduled');
    expect(
      resolveEventLifecycle(base({ openUntil: new Date('2026-10-25T00:00:00Z') }), now),
    ).toBe('expired');
    expect(resolveEventLifecycle(base({ status: 'draft' }), now)).toBe('hidden');
  });

  it('recently ended window', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const ended = base({ openUntil: new Date('2026-10-20T00:00:00Z') });
    expect(isRecentlyEnded(ended, now)).toBe(true);
    expect(eventVisibleForAgent(ended, now)).toBe(true);
    const old = base({ openUntil: new Date('2026-09-01T00:00:00Z') });
    expect(isRecentlyEnded(old, now)).toBe(false);
    expect(eventVisibleForAgent(old, now)).toBe(false);
  });
});

describe('tenant-events match', () => {
  it('scores SMM / UGC query', () => {
    const e = base();
    expect(scoreEventMatch(e, 'Добрий день, я щодо вакансії SMM, також UGC')).toBeGreaterThan(20);
    expect(scoreEventMatch(e, 'скільки манікюр')).toBeLessThan(12);
  });

  it('matchEventsByQuery returns expired hiring as expired', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const e = base({ openUntil: new Date('2026-10-20T00:00:00Z') });
    const hits = matchEventsByQuery([e], 'вакансія SMM', now);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.lifecycle).toBe('expired');
  });
});

describe('formatTenantEventsForPrompt', () => {
  it('splits open and recently ended', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const open = base({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Кастинг манікюр', kind: 'casting' });
    const ended = base({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      title: 'SMM закрито',
      openUntil: new Date('2026-10-20T00:00:00Z'),
    });
    const text = formatTenantEventsForPrompt([open, ended], now);
    expect(text).toContain('Активні події');
    expect(text).toContain('Кастинг манікюр');
    expect(text).toContain('Нещодавно завершені');
    expect(text).toContain('SMM закрито');
  });
});

describe('formatEventToolResult handoff + show_to_client', () => {
  it('requires show_to_client=true for open hiring handoff', async () => {
    const { formatEventToolResult } = await import('./tenant-events.js');
    const text = formatEventToolResult({
      ...base(),
      lifecycle: 'open',
    });
    expect(text).toContain('show_to_client=true');
    expect(text).toContain('request_handoff');
  });
});
