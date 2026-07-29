import { describe, expect, it } from 'vitest';
import {
  evaluateFollowUpNeed,
  FOLLOW_UP_MAX_AGE_MS,
  IG_MESSAGING_WINDOW_MS,
  isIgOutsideMessagingWindowError,
  type MessageForFollowUpEval,
} from './follow-up-eval.js';

const delayMs = 18 * 60 * 60_000; // 18h — fits inside Meta 24h window
const now = Date.parse('2026-07-23T12:00:00Z');

function msg(
  direction: string,
  sender: string,
  hoursAgo: number,
): MessageForFollowUpEval {
  return {
    direction,
    sender,
    createdAt: new Date(now - hoursAgo * 60 * 60_000),
  };
}

describe('evaluateFollowUpNeed', () => {
  it('eligible when last message is bot outbound past delay within IG window', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 19), msg('out', 'bot', 18.5)],
      now,
      {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.consumeWithoutSend).toBe(false);
  });

  it('skips when client replied after bot', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'bot', 19), msg('in', 'client', 1)],
      now,
      {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('client_replied');
    expect(result.consumeWithoutSend).toBe(false);
  });

  it('skips when already sent', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 19), msg('out', 'bot', 18.5)],
      now,
      {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: true,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('already_sent');
  });

  it('skips when delay not reached', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 10), msg('out', 'bot', 9)],
      now,
      {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('too_soon');
    expect(result.consumeWithoutSend).toBe(false);
  });

  it('consumes without Claude when last client inbound is outside Meta window', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 30), msg('out', 'bot', 20)],
      now,
      {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('outside_messaging_window');
    expect(result.consumeWithoutSend).toBe(true);
  });

  it('consumes without Claude when delay exceeds IG messaging window', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 30), msg('out', 'bot', 25)],
      now,
      {
        delayMs: 25 * 60 * 60_000,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('delay_exceeds_window');
    expect(result.consumeWithoutSend).toBe(true);
  });

  it('allows TG follow-up beyond IG window age', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 80), msg('out', 'bot', 75)],
      now,
      {
        delayMs: 18 * 60 * 60_000,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'tg',
      },
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('skips when older than max age (7d) on TG', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'bot', 8 * 24)],
      now,
      {
        delayMs: 18 * 60 * 60_000,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'tg',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('too_old');
    expect(result.consumeWithoutSend).toBe(true);
  });

  it('skips when manager spoke last', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'manager', 19)],
      now,
      {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel: 'ig',
      },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('manager_replied');
  });
});

describe('isIgOutsideMessagingWindowError', () => {
  it('detects Meta subcode 2534022', () => {
    expect(
      isIgOutsideMessagingWindowError(
        new Error('IG API returned 400: {"error":{"error_subcode":2534022}}'),
      ),
    ).toBe(true);
    expect(isIgOutsideMessagingWindowError(new Error('timeout'))).toBe(false);
  });
});

describe('IG_MESSAGING_WINDOW_MS', () => {
  it('is 24 hours', () => {
    expect(IG_MESSAGING_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
