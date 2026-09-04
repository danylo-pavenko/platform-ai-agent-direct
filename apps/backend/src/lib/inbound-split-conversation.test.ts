import { describe, expect, it } from 'vitest';
import { buildClaudeHistoryTurns } from './conversation-history.js';
import {
  extractContactPatchesFromText,
  extractPersonNameFromText,
} from './client-contact-heuristics.js';
import {
  computeCoalesceDelayMs,
  joinInboundBatch,
  looksLikePartialUtterance,
  resolveCoalesceWindowMs,
  resolvePendingInboundFloor,
  type PendingInboundMessage,
} from './inbound-coalesce-helpers.js';

/** Defaults that shipped before adaptive fragment wait. */
const LEGACY = { silenceMs: 600, maxWaitMs: 1_500 };
const COMPLETE = { silenceMs: 900, maxWaitMs: 2_500 };
const PARTIAL = { silenceMs: 2_200, maxWaitMs: 7_000 };

type Bubble = { text: string; atMs: number; id?: string };

/**
 * Replay silence + max-wait coalesce the same way armTimers does:
 * each mid resets silence; a fragment stretches the window; max-wait is
 * counted from burst start.
 */
function coalesceBursts(
  messages: Bubble[],
  complete = COMPLETE,
  partial = PARTIAL,
): string[][] {
  const bursts: string[][] = [];
  let current: {
    texts: string[];
    start: number;
    last: number;
    partial: boolean;
  } | null = null;

  const flush = () => {
    if (current && current.texts.length > 0) bursts.push(current.texts);
    current = null;
  };

  for (const m of messages) {
    if (!current) {
      current = {
        texts: [m.text],
        start: m.atMs,
        last: m.atMs,
        partial: looksLikePartialUtterance(m.text),
      };
      continue;
    }

    const window = resolveCoalesceWindowMs(current.partial, complete, partial);
    const delay = computeCoalesceDelayMs(
      current.last,
      current.start,
      window.silenceMs,
      window.maxWaitMs,
    );
    const fireAt = current.last + delay;
    if (m.atMs > fireAt) {
      flush();
      current = {
        texts: [m.text],
        start: m.atMs,
        last: m.atMs,
        partial: looksLikePartialUtterance(m.text),
      };
      continue;
    }

    current.texts.push(m.text);
    current.last = m.atMs;
    if (looksLikePartialUtterance(m.text)) current.partial = true;
  }
  flush();
  return bursts;
}

function pending(
  over: Partial<PendingInboundMessage> & { id: string; text: string },
): PendingInboundMessage {
  return {
    mediaUrls: null,
    mediaAttachments: null,
    sharedPost: null,
    igContext: null,
    igMessageId: over.igMessageId ?? over.id,
    createdAt: over.createdAt ?? new Date('2026-09-04T12:52:00.000Z'),
    ...over,
  };
}

describe('Moxito booking transcript — split Instagram bubbles', () => {
  const timeNamePhone: Bubble[] = [
    { text: '10:00', atMs: 0 },
    { text: 'Тимофіїв Анжела', atMs: 900 },
    { text: '0930152179', atMs: 1_600 },
  ];

  it('classifies the 12:52 contact burst as fragments, not finished sentences', () => {
    expect(looksLikePartialUtterance('10:00')).toBe(true);
    expect(looksLikePartialUtterance('Тимофіїв Анжела')).toBe(true);
    expect(looksLikePartialUtterance('0930152179')).toBe(true);
    expect(looksLikePartialUtterance('')).toBe(true);
  });

  it('classifies earlier booking questions as complete (short coalesce)', () => {
    expect(looksLikePartialUtterance('Доброго дня!')).toBe(false);
    expect(looksLikePartialUtterance('Хочу записатись на манікюр і брови')).toBe(false);
    expect(looksLikePartialUtterance('На завтра є вільно?')).toBe(false);
    expect(looksLikePartialUtterance('А на коли є вільно?')).toBe(false);
    expect(looksLikePartialUtterance('Який найближча є дата та час?')).toBe(false);
  });

  it('joins time + ПІБ + phone into one Claude user turn', () => {
    const batch = joinInboundBatch([
      pending({ id: 't', text: '10:00' }),
      pending({ id: 'n', text: 'Тимофіїв Анжела' }),
      pending({ id: 'p', text: '0930152179' }),
      pending({ id: 'empty', text: '   ' }),
    ]);
    expect(batch.text).toContain('ОДНА відповідь');
    expect(batch.text).toContain('1) 10:00');
    expect(batch.text).toContain('2) Тимофіїв Анжела');
    expect(batch.text).toContain('3) 0930152179');
    expect(batch.text).not.toMatch(/4\)/);
    expect(batch.messageIds).toEqual(['t', 'n', 'p', 'empty']);
  });

  it('keeps time+name+phone in one burst under the fragment window', () => {
    expect(coalesceBursts(timeNamePhone)).toEqual([
      ['10:00', 'Тимофіїв Анжела', '0930152179'],
    ]);
  });

  it('legacy 600ms/1.5s window would flush each contact bubble as its own turn', () => {
    expect(coalesceBursts(timeNamePhone, LEGACY, LEGACY)).toEqual([
      ['10:00'],
      ['Тимофіїв Анжела'],
      ['0930152179'],
    ]);
  });

  it('still groups the burst when gaps are ~1.5s (typical IG typing)', () => {
    expect(
      coalesceBursts([
        { text: '10:00', atMs: 0 },
        { text: 'Тимофіїв Анжела', atMs: 1_500 },
        { text: '0930152179', atMs: 3_000 },
      ]),
    ).toEqual([['10:00', 'Тимофіїв Анжела', '0930152179']]);
  });

  it('starts a new burst when the name arrives after fragment silence', () => {
    expect(
      coalesceBursts([
        { text: '10:00', atMs: 0 },
        { text: 'Тимофіїв Анжела', atMs: 2_500 },
        { text: '0930152179', atMs: 2_900 },
      ]),
    ).toEqual([['10:00'], ['Тимофіїв Анжела', '0930152179']]);
  });

  it('does not merge a later complete question into the contact burst', () => {
    expect(
      coalesceBursts([
        ...timeNamePhone,
        { text: 'Написала вище', atMs: 60_000 },
      ]),
    ).toEqual([
      ['10:00', 'Тимофіїв Анжела', '0930152179'],
      ['Написала вище'],
    ]);
  });
});

describe('orphan inbound floor (bubbles during in-flight Claude turn)', () => {
  it('does not hide name/phone behind the bot reply timestamp', () => {
    const claimedTen = new Date('2026-09-04T12:52:00.000Z');
    const nameAt = new Date('2026-09-04T12:52:00.400Z');
    const botAskContacts = new Date('2026-09-04T12:52:20.000Z');

    const floor = resolvePendingInboundFloor({
      lastClaimedInboundAt: claimedTen,
      lastRealOutboundAt: botAskContacts,
    });
    expect(floor).toEqual(claimedTen);
    expect(nameAt.getTime()).toBeGreaterThan(floor!.getTime());
    expect(nameAt.getTime()).toBeLessThan(botAskContacts.getTime());
  });

  it('legacy last-outbound floor would have dropped the in-flight name bubble', () => {
    const claimedTen = new Date('2026-09-04T12:52:00.000Z');
    const nameAt = new Date('2026-09-04T12:52:00.400Z');
    const botAskContacts = new Date('2026-09-04T12:52:20.000Z');

    const legacyFloor = botAskContacts;
    expect(nameAt.getTime()).toBeLessThan(legacyFloor.getTime());
    const current = resolvePendingInboundFloor({
      lastClaimedInboundAt: claimedTen,
      lastRealOutboundAt: botAskContacts,
    });
    expect(nameAt.getTime()).toBeGreaterThanOrEqual(current!.getTime());
  });
});

describe('«Написала вище» keeps earlier contact bubbles in Claude history', () => {
  it('does not strip time/name/phone when the current turn is a follow-up', () => {
    const history = buildClaudeHistoryTurns(
      [
        {
          direction: 'out',
          text: 'Вільні варіанти: 10:00, 11:00, 12:00. Напишіть імʼя, прізвище та телефон.',
        },
        { direction: 'in', text: '10:00', igMessageId: 'm-time' },
        { direction: 'in', text: 'Тимофіїв Анжела', igMessageId: 'm-name' },
        { direction: 'in', text: '0930152179', igMessageId: 'm-phone' },
        { direction: 'out', text: 'Для оформлення запису напишіть імʼя та телефон' },
        { direction: 'in', text: 'Написала вище', igMessageId: 'm-follow' },
      ],
      'Написала вище',
      { excludeIgMessageIds: ['m-follow'] },
    );

    const userTurns = history.filter((t) => t.role === 'user').map((t) => t.content);
    expect(userTurns).toEqual(['10:00', 'Тимофіїв Анжела', '0930152179']);
    expect(history.at(-1)?.role).toBe('assistant');
  });
});

describe('contact harvest from the same transcript bubbles', () => {
  it('extracts ПІБ and UA phone from the split bubbles', () => {
    expect(extractPersonNameFromText('Тимофіїв Анжела')).toBe('Тимофіїв Анжела');
    expect(extractContactPatchesFromText('Тимофіїв Анжела').displayName).toBe(
      'Тимофіїв Анжела',
    );
    expect(extractContactPatchesFromText('0930152179').phone).toBe('+380930152179');
  });

  it('does not treat service details or greetings as a name', () => {
    expect(
      extractPersonNameFromText('Манікюр : зняття чистка покриття, укріплення і френч'),
    ).toBeUndefined();
    expect(extractPersonNameFromText('Доброго дня!')).toBeUndefined();
    expect(extractPersonNameFromText('Написала вище')).toBeUndefined();
  });
});
