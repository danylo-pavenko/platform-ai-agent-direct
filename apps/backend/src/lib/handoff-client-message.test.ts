import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDOFF_CLIENT_MESSAGE,
  resolveHandoffClientMessage,
} from './handoff-client-message.js';

describe('resolveHandoffClientMessage', () => {
  it('uses Claude text when present', () => {
    const text =
      'Дякую за цікавість до вакансії SMM. Я Моксі — передаю керівнику студії.';
    expect(resolveHandoffClientMessage(text)).toBe(text);
  });

  it('falls back when empty / whitespace / missing', () => {
    expect(resolveHandoffClientMessage('')).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
    expect(resolveHandoffClientMessage('   \n')).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
    expect(resolveHandoffClientMessage(null)).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
    expect(resolveHandoffClientMessage(undefined)).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
  });

  it('trims but keeps intentional short replies', () => {
    expect(resolveHandoffClientMessage('  Передаю менеджеру.  ')).toBe('Передаю менеджеру.');
  });
});
