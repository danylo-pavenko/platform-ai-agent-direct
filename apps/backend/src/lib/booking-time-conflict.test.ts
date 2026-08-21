import { describe, expect, it } from 'vitest';
import {
  buildClientFacingTimeConflictReply,
  excludeFailedTimeFromSlotLines,
  formatParallelServiceMasterLines,
  formatTimeConflictToolResult,
  normalizeSlotTimeKey,
} from './booking-time-conflict.js';
import { isReactionOnlyInbound } from './ig-inbound-context.js';

describe('booking-time-conflict', () => {
  it('normalizes clock keys', () => {
    expect(normalizeSlotTimeKey('11:00')).toBe('11:00');
    expect(normalizeSlotTimeKey('9:30:00')).toBe('09:30');
  });

  it('excludes failed time from slot lines', () => {
    const text = [
      '## 05.09.2026',
      '- 11:00 | nails: Іванка; pedi: Аліна',
      '- 12:00 | nails: Іванка; pedi: Аліна',
      '- 13:00 | nails: Іванка; pedi: Аліна',
    ].join('\n');
    const next = excludeFailedTimeFromSlotLines(text, '11:00');
    expect(next).not.toContain('11:00');
    expect(next).toContain('12:00');
  });

  it('formats TIME_CONFLICT tool result with alternatives', () => {
    const tool = formatTimeConflictToolResult({
      failedDate: '05.09.2026',
      failedTime: '11:00',
      alternativesText: '## 05.09.2026\n- 12:00 | майстри: Аліна',
    });
    expect(tool).toMatch(/TIME_CONFLICT/);
    expect(tool).toMatch(/НЕ пиши клієнту/);
    expect(tool).toContain('12:00');
  });

  it('builds client-facing reply from alternatives', () => {
    const tool = formatTimeConflictToolResult({
      failedDate: '05.09.2026',
      failedTime: '11:00',
      alternativesText: [
        '## 05.09.2026',
        '- 12:00 | манікюр: Іванка; педикюр: Аліна | tools: …',
        '- 13:00 | манікюр: Іванка; педикюр: Аліна | tools: …',
      ].join('\n'),
    });
    const reply = buildClientFacingTimeConflictReply(tool);
    expect(reply).toMatch(/зайнявся/);
    expect(reply).toContain('12:00');
    expect(reply).not.toMatch(/tools:/);
  });
});

describe('formatParallelServiceMasterLines', () => {
  it('binds each service to a master id for book_appointment', () => {
    const lines = formatParallelServiceMasterLines(
      [
        { id: 'svc-1', name: 'Манікюр', masterId: 'm1' },
        { id: 'svc-2', name: 'Педикюр', masterId: 'm2' },
      ],
      new Map([
        ['m1', 'Іванка'],
        ['m2', 'Аліна'],
      ]),
    );
    expect(lines[0]).toContain('Манікюр');
    expect(lines[0]).toContain('[master_id=m1]');
    expect(lines[1]).toContain('Педикюр');
    expect(lines[1]).toContain('[master_id=m2]');
  });
});

describe('isReactionOnlyInbound', () => {
  it('detects empty reaction turns', () => {
    expect(
      isReactionOnlyInbound({
        messageText: '',
        igContext: { kind: 'reaction', reaction: { targetMid: 'x', action: 'react', reaction: 'love' } },
      }),
    ).toBe(true);
  });

  it('does not skip when client also sent text or media', () => {
    expect(
      isReactionOnlyInbound({
        messageText: 'Дякую',
        igContext: { kind: 'reaction', reaction: { targetMid: 'x', action: 'react' } },
      }),
    ).toBe(false);
    expect(
      isReactionOnlyInbound({
        messageText: '',
        igContext: { kind: 'reaction', reaction: { targetMid: 'x', action: 'react' } },
        hasVisualMedia: true,
      }),
    ).toBe(false);
  });
});
