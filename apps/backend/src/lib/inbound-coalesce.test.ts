import { describe, expect, it } from 'vitest';
import {
  computeCoalesceDelayMs,
  joinInboundBatch,
  looksLikePartialUtterance,
  resolveCoalesceWindowMs,
  resolvePendingInboundFloor,
  shouldBootstrapIgTyping,
  type PendingInboundMessage,
} from './inbound-coalesce-helpers.js';

describe('shouldBootstrapIgTyping', () => {
  it('allows typing only for bot-owned conversations', () => {
    expect(shouldBootstrapIgTyping('bot')).toBe(true);
    expect(shouldBootstrapIgTyping('handoff')).toBe(false);
    expect(shouldBootstrapIgTyping('closed')).toBe(false);
    expect(shouldBootstrapIgTyping('paused')).toBe(false);
  });
});

describe('computeCoalesceDelayMs', () => {
  it('returns silence delay when under max-wait', () => {
    const burst = 1_000;
    expect(computeCoalesceDelayMs(1_000, burst, 600, 1_500)).toBe(600);
    expect(computeCoalesceDelayMs(1_200, burst, 600, 1_500)).toBe(600);
  });

  it('caps at max-wait from burst start', () => {
    const burst = 1_000;
    // now=2400 → silence would fire at 3000, max at 2500 → delay 100
    expect(computeCoalesceDelayMs(2_400, burst, 600, 1_500)).toBe(100);
  });

  it('returns 0 when max-wait already elapsed', () => {
    expect(computeCoalesceDelayMs(3_000, 1_000, 600, 1_500)).toBe(0);
  });
});

describe('joinInboundBatch', () => {
  const base = (over: Partial<PendingInboundMessage>): PendingInboundMessage => ({
    id: 'id',
    text: null,
    mediaUrls: null,
    mediaAttachments: null,
    sharedPost: null,
    igContext: null,
    igMessageId: null,
    createdAt: new Date(),
    ...over,
  });

  it('passes through a single text message', () => {
    const batch = joinInboundBatch([
      base({ id: 'a', text: 'Привіт', igMessageId: 'm1' }),
    ]);
    expect(batch.text).toBe('Привіт');
    expect(batch.igMessageIds).toEqual(['m1']);
    expect(batch.messageIds).toEqual(['a']);
  });

  it('joins multiple texts as one numbered utterance', () => {
    const batch = joinInboundBatch([
      base({ id: 'a', text: 'Привіт', igMessageId: 'm1' }),
      base({ id: 'b', text: 'Хочу стрижку', igMessageId: 'm2' }),
    ]);
    expect(batch.text).toContain('кілька повідомлень');
    expect(batch.text).toContain('ОДНА відповідь');
    expect(batch.text).toContain('1) Привіт');
    expect(batch.text).toContain('2) Хочу стрижку');
    expect(batch.igMessageIds).toEqual(['m1', 'm2']);
  });

  it('merges media and takes first shared post', () => {
    const batch = joinInboundBatch([
      base({
        id: 'a',
        text: '',
        mediaUrls: ['u1.jpg'],
        mediaAttachments: [{ kind: 'image', igType: 'image', status: 'ready', storageKey: 'u1.jpg' }],
        sharedPost: { postUrl: 'https://ig/p/1', caption: 'cap' },
      }),
      base({
        id: 'b',
        text: 'look',
        mediaUrls: ['u2.jpg'],
        sharedPost: { postUrl: 'https://ig/p/2' },
      }),
    ]);
    expect(batch.mediaUrls).toEqual(['u1.jpg', 'u2.jpg']);
    expect(batch.mediaAttachments).toHaveLength(1);
    expect(batch.sharedPost?.postUrl).toBe('https://ig/p/1');
    expect(batch.text).toBe('look');
  });

  it('prefers story_reply igContext over an earlier reaction in the batch', () => {
    const batch = joinInboundBatch([
      base({
        id: 'a',
        text: 'Реакція ❤️',
        igContext: {
          kind: 'reaction',
          reaction: { targetMid: 'm0', action: 'react', reaction: 'love' },
        },
      }),
      base({
        id: 'b',
        text: 'Хочу записатись',
        igContext: { kind: 'story_reply', story: { id: 's1' } },
      }),
    ]);
    expect(batch.igContext?.kind).toBe('story_reply');
    expect(batch.text).toContain('кілька повідомлень');
  });
});

describe('looksLikePartialUtterance', () => {
  it('treats time, phone and ПІБ bubbles as fragments', () => {
    expect(looksLikePartialUtterance('10:00')).toBe(true);
    expect(looksLikePartialUtterance('0930152179')).toBe(true);
    expect(looksLikePartialUtterance('Тимофіїв Анжела')).toBe(true);
    expect(looksLikePartialUtterance('05.09.2026')).toBe(true);
    expect(looksLikePartialUtterance('')).toBe(true);
  });

  it('treats complete questions and acks as finished utterances', () => {
    expect(looksLikePartialUtterance('На завтра є вільно?')).toBe(false);
    expect(looksLikePartialUtterance('Так')).toBe(false);
    expect(looksLikePartialUtterance('Добре!')).toBe(false);
    expect(looksLikePartialUtterance('Хочу записатись на манікюр і брови')).toBe(false);
  });
});

describe('resolvePendingInboundFloor', () => {
  it('prefers last claimed inbound so in-flight bubbles are not orphaned by the bot reply', () => {
    const claimed = new Date('2026-09-04T12:52:00.000Z');
    const outbound = new Date('2026-09-04T12:52:20.000Z');
    const floor = resolvePendingInboundFloor({
      lastClaimedInboundAt: claimed,
      lastRealOutboundAt: outbound,
    });
    expect(floor?.toISOString()).toBe(claimed.toISOString());
  });

  it('falls back to last outbound when nothing has been claimed yet', () => {
    const outbound = new Date('2026-09-04T12:50:00.000Z');
    const floor = resolvePendingInboundFloor({
      lastClaimedInboundAt: null,
      lastRealOutboundAt: outbound,
    });
    expect(floor?.toISOString()).toBe(outbound.toISOString());
  });

  it('raises the floor to onlyAfter for drain follow-ups', () => {
    const claimed = new Date('2026-09-04T12:52:00.000Z');
    const onlyAfter = new Date('2026-09-04T12:52:05.000Z');
    const floor = resolvePendingInboundFloor({
      lastClaimedInboundAt: claimed,
      onlyAfter,
    });
    expect(floor?.toISOString()).toBe(onlyAfter.toISOString());
  });
});

describe('resolveCoalesceWindowMs', () => {
  it('keeps complete-utterance window when the burst is not a fragment', () => {
    expect(
      resolveCoalesceWindowMs(
        false,
        { silenceMs: 900, maxWaitMs: 2500 },
        { silenceMs: 2200, maxWaitMs: 7000 },
      ),
    ).toEqual({ silenceMs: 900, maxWaitMs: 2500 });
  });

  it('stretches silence and max-wait for a partial burst', () => {
    expect(
      resolveCoalesceWindowMs(
        true,
        { silenceMs: 900, maxWaitMs: 2500 },
        { silenceMs: 2200, maxWaitMs: 7000 },
      ),
    ).toEqual({ silenceMs: 2200, maxWaitMs: 7000 });
  });
});
