import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_TIMEOUT,
} from '../lib/agent-fallback.js';
import { evaluateConversationRetryNeed } from './conversation-retry.js';

const MIN_AGE = 120_000;
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function at(offsetMs: number): Date {
  return new Date(1_000_000_000_000 + offsetMs);
}

describe('evaluateConversationRetryNeed', () => {
  const baseOpts = {
    minAgeMs: MIN_AGE,
    maxAgeMs: MAX_AGE,
    maxBotAttemptsAfterInbound: MAX_ATTEMPTS,
  };

  it('needs retry when client message has no outbound reply', () => {
    const now = at(300_000);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'in',
          sender: 'client',
          text: 'Привіт',
          createdAt: at(0),
        },
      ],
      now.getTime(),
      baseOpts,
    );
    expect(result).toEqual({ needed: true, reason: 'ok', inboundAt: at(0) });
  });

  it('skips when too soon after inbound', () => {
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'in',
          sender: 'client',
          text: 'Привіт',
          createdAt: at(250_000),
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    expect(result.reason).toBe('too_soon');
    expect(result.needed).toBe(false);
  });

  it('needs retry when only fallback bot replies exist after inbound', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_TIMEOUT,
          createdAt: at(60_000),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Є худі M?',
          createdAt: inboundAt,
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    expect(result).toEqual({ needed: true, reason: 'ok', inboundAt });
  });

  it('skips when a real bot reply was sent after inbound', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'bot',
          text: 'Так, є в наявності худі M за 1200 грн.',
          createdAt: at(90_000),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Є худі M?',
          createdAt: inboundAt,
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    expect(result.reason).toBe('real_bot_reply');
  });

  it('skips when manager already replied', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'manager',
          text: 'Добрий день!',
          createdAt: at(120_000),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Потрібна допомога',
          createdAt: inboundAt,
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    expect(result.reason).toBe('manager_replied');
  });

  it('stops after max bot attempts following inbound', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_BUSY,
          createdAt: at(180_000),
        },
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_TIMEOUT,
          createdAt: at(120_000),
        },
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_BUSY,
          createdAt: at(60_000),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Ало',
          createdAt: inboundAt,
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    expect(result.reason).toBe('max_attempts');
  });
});
