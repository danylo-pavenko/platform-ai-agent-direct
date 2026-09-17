import { describe, expect, it } from 'vitest';
import {
  isConversationStaleForNewSession,
  isSessionGapPastFreshness,
  sessionGapDays,
} from './session-freshness.js';

const DAY = 86_400_000;
const now = Date.parse('2026-09-17T15:03:00.000Z');

describe('isConversationStaleForNewSession', () => {
  it('closes a bot thread after freshnessDays of silence', () => {
    expect(
      isConversationStaleForNewSession({
        state: 'bot',
        lastMessageAt: new Date(now - 15 * DAY),
        sessionFreshnessDays: 14,
        nowMs: now,
      }),
    ).toBe(true);
  });

  it('closes a handoff thread after the same silence (does not wait forever for a manager)', () => {
    expect(
      isConversationStaleForNewSession({
        state: 'handoff',
        lastMessageAt: new Date(now - 36 * DAY),
        sessionFreshnessDays: 14,
        nowMs: now,
      }),
    ).toBe(true);
  });

  it('leaves a recent handoff alone so idle TTL can return the bot in-thread', () => {
    expect(
      isConversationStaleForNewSession({
        state: 'handoff',
        lastMessageAt: new Date(now - 2 * 60 * 60 * 1000),
        sessionFreshnessDays: 14,
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('does not close paused threads', () => {
    expect(
      isConversationStaleForNewSession({
        state: 'paused',
        lastMessageAt: new Date(now - 40 * DAY),
        sessionFreshnessDays: 14,
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('does not close when lastMessageAt is missing or freshness is 0', () => {
    expect(
      isConversationStaleForNewSession({
        state: 'bot',
        lastMessageAt: null,
        sessionFreshnessDays: 14,
        nowMs: now,
      }),
    ).toBe(false);
    expect(
      isConversationStaleForNewSession({
        state: 'bot',
        lastMessageAt: new Date(now - 40 * DAY),
        sessionFreshnessDays: 0,
        nowMs: now,
      }),
    ).toBe(false);
  });
});

describe('session gap helpers', () => {
  it('counts whole days between stamps', () => {
    expect(
      sessionGapDays(new Date('2026-08-12T19:02:00.000Z'), new Date('2026-09-17T15:03:00.000Z')),
    ).toBe(35);
  });

  it('treats freshness as a strict outer bound', () => {
    const from = new Date(now - 14 * DAY);
    expect(isSessionGapPastFreshness(from, new Date(now), 14)).toBe(false);
    expect(isSessionGapPastFreshness(new Date(now - 14 * DAY - 1), new Date(now), 14)).toBe(true);
  });
});
