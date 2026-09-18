import { describe, expect, it } from 'vitest';
import { buildClaudeHistoryTurns } from './conversation-history.js';

describe('buildClaudeHistoryTurns', () => {
  it('excludes last inbound when text matches current user message', () => {
    const history = buildClaudeHistoryTurns(
      [
        { direction: 'in', text: 'Привіт' },
        { direction: 'out', text: 'Вітаю!' },
        { direction: 'in', text: 'Скільки коштує?' },
      ],
      'Скільки коштує?',
    );
    expect(history).toEqual([
      { role: 'user', content: 'Привіт' },
      { role: 'assistant', content: 'Вітаю!' },
    ]);
  });

  it('excludes by igMessageId when provided', () => {
    const history = buildClaudeHistoryTurns(
      [
        { direction: 'in', text: 'old', igMessageId: 'm1' },
        { direction: 'in', text: 'voice transcript', igMessageId: 'm2' },
      ],
      'different',
      { excludeIgMessageId: 'm2' },
    );
    expect(history).toEqual([{ role: 'user', content: 'old' }]);
  });

  it('excludes multiple trailing inbound mids from a coalesced turn', () => {
    const history = buildClaudeHistoryTurns(
      [
        { direction: 'out', text: 'Вітаю!' },
        { direction: 'in', text: 'Привіт', igMessageId: 'm1' },
        { direction: 'in', text: 'Хочу стрижку', igMessageId: 'm2' },
      ],
      'Клієнт надіслав кілька повідомлень підряд — це ОДНА відповідь (читай суцільно, не як окремі репліки):\n1) Привіт\n2) Хочу стрижку',
      { excludeIgMessageIds: ['m1', 'm2'] },
    );
    expect(history).toEqual([{ role: 'assistant', content: 'Вітаю!' }]);
  });

  it('skips system and empty rows', () => {
    const history = buildClaudeHistoryTurns(
      [
        { direction: 'system', text: 'meta' },
        { direction: 'in', text: '   ' },
        { direction: 'out', text: 'ok' },
      ],
      '',
    );
    expect(history).toEqual([{ role: 'assistant', content: 'ok' }]);
  });

  it('stamps date, time and sender when timeZone is set', () => {
    const history = buildClaudeHistoryTurns(
      [
        {
          direction: 'in',
          sender: 'client',
          text: 'Добрий вечір',
          createdAt: new Date('2026-08-12T18:46:00.000Z'),
        },
        {
          direction: 'out',
          sender: 'manager',
          text: 'Знайдіть 04.08',
          createdAt: new Date('2026-08-12T18:46:30.000Z'),
        },
      ],
      'нове',
      { timeZone: 'Europe/Kyiv' },
    );
    expect(history[0]?.content).toMatch(/^\[12\.08\.2026 21:46 клієнт\] Добрий вечір$/);
    expect(history[1]?.content).toMatch(/^\[12\.08\.2026 21:46 менеджер\] Знайдіть 04\.08$/);
    expect(history[1]?.role).toBe('assistant');
  });

  it('stamps native Instagram manager echoes separately', () => {
    const history = buildClaudeHistoryTurns(
      [
        {
          direction: 'out',
          sender: 'manager',
          text: 'Зараз гляну в Instagram',
          createdAt: new Date('2026-08-12T18:46:30.000Z'),
          igContext: { kind: 'ig_native_echo', source: 'webhook_echo' },
        },
      ],
      'нове',
      { timeZone: 'Europe/Kyiv' },
    );
    expect(history[0]?.content).toMatch(
      /^\[12\.08\.2026 21:46 менеджер Instagram\] Зараз гляну в Instagram$/,
    );
  });

  it('inserts a long-pause notice between distant turns', () => {
    const history = buildClaudeHistoryTurns(
      [
        {
          direction: 'out',
          sender: 'manager',
          text: 'Замовлення на зупинці',
          createdAt: new Date('2026-08-12T19:02:00.000Z'),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Добрий вечір, хочу худі',
          createdAt: new Date('2026-09-17T15:03:00.000Z'),
          igMessageId: 'keep',
        },
      ],
      'інше',
      { timeZone: 'Europe/Kyiv', sessionFreshnessDays: 14 },
    );
    expect(history).toHaveLength(2);
    expect(history[1]?.content).toMatch(/Пауза \d+ дн\./);
    expect(history[1]?.content).toMatch(/нове звернення/);
    expect(history[1]?.content).toContain('Добрий вечір, хочу худі');
  });
});
