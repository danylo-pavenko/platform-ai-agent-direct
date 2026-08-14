import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    CONVERSATION_RETRY_ENABLED: true,
    CONVERSATION_RETRY_INTERVAL_MIN: 5,
    CONVERSATION_RETRY_MIN_AGE_MS: 120_000,
    CONVERSATION_RETRY_MAX_AGE_MS: 86_400_000,
    CONVERSATION_RETRY_BATCH_SIZE: 15,
    CONVERSATION_RETRY_MAX_BOT_ATTEMPTS: 3,
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./claude-auth.js', () => ({ getClaudeAuthStatus: vi.fn() }));
vi.mock('../lib/inbound-coalesce.js', () => ({
  clearInboundClaims: vi.fn(),
  flushInboundBotTurnNow: vi.fn(),
}));

import {
  AGENT_FALLBACK_RETRY_NOTE,
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

  it('still marks rate-limit fallbacks as needed (catch-up after quota reset)', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_TIMEOUT,
          createdAt: at(60_000),
          botFailureDetail:
            "Ліміт сесії Claude (429). You've hit your session limit · resets 2:40pm",
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Привіт',
          createdAt: inboundAt,
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    // Pass-level quota gate blocks retries while exhausted; after reset we catch up.
    expect(result).toEqual({ needed: true, reason: 'ok', inboundAt });
  });

  it('needs retry when suppressed retry notes follow the first fallback', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'bot',
          text: AGENT_FALLBACK_RETRY_NOTE,
          createdAt: at(120_000),
        },
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_TIMEOUT,
          createdAt: at(60_000),
        },
        {
          direction: 'in',
          sender: 'client',
          text: 'Завтра о 15:00, майстер Іванка',
          createdAt: inboundAt,
        },
      ],
      at(300_000).getTime(),
      baseOpts,
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toBe('ok');
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

  it('counts suppressed retry notes toward max bot attempts', () => {
    const inboundAt = at(0);
    const result = evaluateConversationRetryNeed(
      [
        {
          direction: 'out',
          sender: 'bot',
          text: AGENT_FALLBACK_RETRY_NOTE,
          createdAt: at(180_000),
        },
        {
          direction: 'out',
          sender: 'bot',
          text: AGENT_FALLBACK_RETRY_NOTE,
          createdAt: at(120_000),
        },
        {
          direction: 'out',
          sender: 'bot',
          text: CUSTOMER_FALLBACK_TIMEOUT,
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
    expect(result.needed).toBe(false);
  });
});
