import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDOFF_CLIENT_MESSAGE,
  parseHandoffShowToClient,
  resolveHandoffClientMessage,
} from './handoff-client-message.js';

describe('resolveHandoffClientMessage', () => {
  const clientCopy =
    'Дякую за цікавість до вакансії SMM. Я Моксі — передаю керівнику студії.';

  it('uses Claude text only when showToClient is true', () => {
    expect(
      resolveHandoffClientMessage({ agentText: clientCopy, showToClient: true }),
    ).toBe(clientCopy);
  });

  it('ignores non-empty agent text when showToClient is false / missing', () => {
    expect(
      resolveHandoffClientMessage({
        agentText: 'Менеджеру: перевірити ТТН і бонуси',
        showToClient: false,
      }),
    ).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
    expect(
      resolveHandoffClientMessage({
        agentText: 'Менеджеру: перевірити ТТН і бонуси',
      }),
    ).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
    expect(
      resolveHandoffClientMessage({
        agentText: 'Менеджеру: перевірити ТТН',
        showToClient: null,
      }),
    ).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
  });

  it('falls back when showToClient true but text empty', () => {
    expect(resolveHandoffClientMessage({ agentText: '', showToClient: true })).toBe(
      DEFAULT_HANDOFF_CLIENT_MESSAGE,
    );
    expect(resolveHandoffClientMessage({ agentText: '   \n', showToClient: true })).toBe(
      DEFAULT_HANDOFF_CLIENT_MESSAGE,
    );
    expect(resolveHandoffClientMessage({ showToClient: true })).toBe(
      DEFAULT_HANDOFF_CLIENT_MESSAGE,
    );
  });

  it('legacy string arg still prefers non-empty text', () => {
    expect(resolveHandoffClientMessage(clientCopy)).toBe(clientCopy);
    expect(resolveHandoffClientMessage('')).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
    expect(resolveHandoffClientMessage(null)).toBe(DEFAULT_HANDOFF_CLIENT_MESSAGE);
  });

  it('trims intentional short client replies when opted in', () => {
    expect(
      resolveHandoffClientMessage({
        agentText: '  Передаю менеджеру.  ',
        showToClient: true,
      }),
    ).toBe('Передаю менеджеру.');
  });
});

describe('parseHandoffShowToClient', () => {
  it('only true opts in', () => {
    expect(parseHandoffShowToClient(true)).toBe(true);
    expect(parseHandoffShowToClient(false)).toBe(false);
    expect(parseHandoffShowToClient('true')).toBe(false);
    expect(parseHandoffShowToClient(1)).toBe(false);
    expect(parseHandoffShowToClient(undefined)).toBe(false);
    expect(parseHandoffShowToClient(null)).toBe(false);
  });
});
