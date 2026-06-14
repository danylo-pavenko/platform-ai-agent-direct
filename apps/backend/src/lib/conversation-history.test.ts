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
});
