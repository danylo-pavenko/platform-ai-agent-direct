import { describe, expect, it } from 'vitest';
import {
  computeCoalesceDelayMs,
  joinInboundBatch,
  type PendingInboundMessage,
} from './inbound-coalesce-helpers.js';

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

  it('joins multiple texts with a short preamble', () => {
    const batch = joinInboundBatch([
      base({ id: 'a', text: 'Привіт', igMessageId: 'm1' }),
      base({ id: 'b', text: 'Хочу стрижку', igMessageId: 'm2' }),
    ]);
    expect(batch.text).toContain('кілька повідомлень');
    expect(batch.text).toContain('Привіт');
    expect(batch.text).toContain('Хочу стрижку');
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
});
