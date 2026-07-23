import { describe, expect, it } from 'vitest';
import {
  evaluateFollowUpNeed,
  FOLLOW_UP_MAX_AGE_MS,
  type MessageForFollowUpEval,
} from './follow-up-eval.js';

const delayMs = 30 * 60_000;
const now = Date.parse('2026-07-23T12:00:00Z');

function msg(
  direction: string,
  sender: string,
  minutesAgo: number,
): MessageForFollowUpEval {
  return {
    direction,
    sender,
    createdAt: new Date(now - minutesAgo * 60_000),
  };
}

describe('evaluateFollowUpNeed', () => {
  it('eligible when last message is bot outbound past delay', () => {
    const result = evaluateFollowUpNeed(
      [msg('in', 'client', 60), msg('out', 'bot', 45)],
      now,
      { delayMs, maxAgeMs: FOLLOW_UP_MAX_AGE_MS, followUpAlreadySent: false },
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('skips when client replied after bot', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'bot', 45), msg('in', 'client', 10)],
      now,
      { delayMs, maxAgeMs: FOLLOW_UP_MAX_AGE_MS, followUpAlreadySent: false },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('client_replied');
  });

  it('skips when already sent', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'bot', 45)],
      now,
      { delayMs, maxAgeMs: FOLLOW_UP_MAX_AGE_MS, followUpAlreadySent: true },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('already_sent');
  });

  it('skips when delay not reached', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'bot', 10)],
      now,
      { delayMs, maxAgeMs: FOLLOW_UP_MAX_AGE_MS, followUpAlreadySent: false },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('too_soon');
  });

  it('skips when older than max age', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'bot', 25 * 60)],
      now,
      { delayMs, maxAgeMs: FOLLOW_UP_MAX_AGE_MS, followUpAlreadySent: false },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('too_old');
  });

  it('skips when manager spoke last', () => {
    const result = evaluateFollowUpNeed(
      [msg('out', 'manager', 45)],
      now,
      { delayMs, maxAgeMs: FOLLOW_UP_MAX_AGE_MS, followUpAlreadySent: false },
    );
    expect(result.needed).toBe(false);
    expect(result.reason).toBe('manager_replied');
  });
});
