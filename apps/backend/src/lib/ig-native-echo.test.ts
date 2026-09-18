import { describe, expect, it } from 'vitest';
import { parseGraphSendMessageId } from './ig-graph-message-id.js';
import {
  buildIgNativeEchoContext,
  echoConversationEffect,
  echoDisplayText,
  extractEchoEventsFromWebhookBody,
  IG_NATIVE_ECHO_KIND,
  isIgNativeEchoContext,
  matchOwnPlatformSend,
  outboundHasGraphMessageId,
  textsMatchForEchoDedupe,
} from './ig-native-echo.js';

const CLIENT = '17841410659012767';
const BUSINESS = '17841437228550639';

describe('extractEchoEventsFromWebhookBody', () => {
  it('extracts is_echo DMs with client as recipient', () => {
    const events = extractEchoEventsFromWebhookBody({
      object: 'instagram',
      entry: [
        {
          id: BUSINESS,
          messaging: [
            {
              sender: { id: BUSINESS },
              recipient: { id: CLIENT },
              timestamp: 1_700_000_000_000,
              message: { mid: 'mid.echo.1', text: 'Дякуємо, зараз глянемо', is_echo: true },
            },
            {
              sender: { id: CLIENT },
              recipient: { id: BUSINESS },
              timestamp: 1_700_000_000_100,
              message: { mid: 'mid.in.1', text: 'Привіт', is_echo: false },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        mid: 'mid.echo.1',
        senderId: BUSINESS,
        recipientId: CLIENT,
        timestamp: 1_700_000_000_000,
        text: 'Дякуємо, зараз глянемо',
        attachmentTypes: [],
        mediaUrls: [],
      },
    ]);
  });

  it('dedupes the same mid across messaging and changes', () => {
    const events = extractEchoEventsFromWebhookBody({
      entry: [
        {
          messaging: [
            {
              sender: { id: BUSINESS },
              recipient: { id: CLIENT },
              message: { mid: 'mid.1', text: 'Hi', is_echo: true },
            },
          ],
          changes: [
            {
              value: {
                sender: { id: BUSINESS },
                recipient: { id: CLIENT },
                message: { mid: 'mid.1', text: 'Hi', is_echo: true },
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
  });
});

describe('matchOwnPlatformSend', () => {
  it('matches by Graph message id', () => {
    const hit = matchOwnPlatformSend(
      { mid: 'm1', text: 'Вітаю' },
      [
        {
          id: 'row-1',
          sender: 'bot',
          text: 'Вітаю',
          igMessageId: 'm1',
          createdAt: new Date(),
        },
      ],
    );
    expect(hit).toEqual({ kind: 'mid', messageId: 'row-1' });
  });

  it('matches extra platformSendMids', () => {
    expect(
      outboundHasGraphMessageId(
        { igMessageId: 'm1', igContext: { platformSendMids: ['m1', 'm2'] } },
        'm2',
      ),
    ).toBe(true);
  });

  it('matches recent same text when mid is not stored yet', () => {
    const hit = matchOwnPlatformSend(
      { mid: 'later-echo', text: 'Замовлення прийнято!' },
      [
        {
          id: 'row-bot',
          sender: 'bot',
          text: 'Замовлення прийнято!',
          igMessageId: null,
          createdAt: new Date(),
        },
      ],
    );
    expect(hit?.kind).toBe('heuristic');
    expect(hit?.messageId).toBe('row-bot');
  });

  it('does not treat an old similar bot line as our send', () => {
    const hit = matchOwnPlatformSend(
      { mid: 'native', text: 'Дякуємо' },
      [
        {
          id: 'old',
          sender: 'bot',
          text: 'Дякуємо',
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      ],
    );
    expect(hit).toBeNull();
  });
});

describe('echo helpers', () => {
  it('labels media-only echoes', () => {
    expect(echoDisplayText({ text: '', attachmentTypes: ['image'] })).toBe('[медіа Instagram]');
  });

  it('hands bot threads off and leaves paused as persist-only', () => {
    expect(echoConversationEffect('bot')).toBe('handoff');
    expect(echoConversationEffect('handoff')).toBe('persist_only');
    expect(echoConversationEffect('paused')).toBe('persist_only');
    expect(echoConversationEffect('closed')).toBe('skip');
  });

  it('recognizes native echo context and substring splits', () => {
    expect(isIgNativeEchoContext(buildIgNativeEchoContext('webhook_echo'))).toBe(true);
    expect(isIgNativeEchoContext({ kind: 'detected_phone' })).toBe(false);
    expect(buildIgNativeEchoContext('webhook_echo').kind).toBe(IG_NATIVE_ECHO_KIND);
    expect(textsMatchForEchoDedupe('Частина два довша за вісім', 'Частина один. Частина два довша за вісім')).toBe(
      true,
    );
  });
});

describe('parseGraphSendMessageId', () => {
  it('reads message_id from Graph send JSON', () => {
    expect(parseGraphSendMessageId({ recipient_id: '1', message_id: 'mid.abc' })).toBe('mid.abc');
  });

  it('returns null for empty or unexpected payloads', () => {
    expect(parseGraphSendMessageId(null)).toBeNull();
    expect(parseGraphSendMessageId({})).toBeNull();
    expect(parseGraphSendMessageId({ message_id: 1 })).toBeNull();
  });
});
