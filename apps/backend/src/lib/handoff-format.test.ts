import { describe, expect, it } from 'vitest';
import {
  formatHandoffMessageLine,
  formatTelegramClientLabel,
  isHandoffServiceNote,
  selectHandoffServiceNotes,
  selectManagerFacingHandoffLines,
  unwrapCoalescePreamble,
} from './handoff-format.js';
import { AGENT_TURN_DEBUG_PREFIX } from './agent-turn-debug.js';
import { VISION_DEBUG_PREFIX } from './vision-debug-note.js';

describe('formatHandoffMessageLine', () => {
  it('prefixes voice transcript with mic emoji', () => {
    const line = formatHandoffMessageLine({
      sender: 'client',
      text: 'Хочу стрижку',
      mediaAttachments: [
        {
          kind: 'audio',
          igType: 'audio',
          status: 'ready',
          storageKey: '2026/06/a.m4a',
          transcript: 'Хочу стрижку',
          sttStatus: 'ok',
        },
      ],
    });
    expect(line?.isVoice).toBe(true);
    expect(line?.text).toBe('🎤 Хочу стрижку');
  });

  it('shows placeholder when voice without transcript', () => {
    const line = formatHandoffMessageLine({
      sender: 'client',
      text: null,
      mediaAttachments: [
        { kind: 'audio', igType: 'audio', status: 'ready', storageKey: 'x.m4a' },
      ],
    });
    expect(line?.text).toContain('Голосове');
  });

  it('returns null for empty non-voice message', () => {
    expect(formatHandoffMessageLine({ sender: 'bot', text: '  ' })).toBeNull();
  });
});

describe('formatTelegramClientLabel', () => {
  it('prefers display name', () => {
    expect(
      formatTelegramClientLabel({
        displayName: 'Оля',
        igUsername: 'ola.fit',
        igUserId: '3380613918779953',
      }),
    ).toBe('Оля');
  });

  it('uses a person-like display name', () => {
    expect(
      formatTelegramClientLabel({
        displayName: 'Олена Коваль',
        igUsername: 'olena.k',
      }),
    ).toBe('Олена Коваль');
  });

  it('ignores an Instagram profile headline as the person name', () => {
    expect(
      formatTelegramClientLabel({
        displayName: 'Йога для вагітних і після пологів',
        igUsername: 'diana.dombek',
      }),
    ).toBe('@diana.dombek');
  });

  it('uses @username when name is missing', () => {
    expect(
      formatTelegramClientLabel({
        igUsername: 'ola.fit',
        igUserId: '3380613918779953',
      }),
    ).toBe('@ola.fit');
  });

  it('does not treat IGSID as a username', () => {
    expect(formatTelegramClientLabel({ igUserId: '3380613918779953' })).toBe(
      'клієнт Instagram',
    );
  });
});

describe('handoff last-message filters', () => {
  it('unwraps coalesce preamble', () => {
    const raw =
      'Клієнт надіслав кілька повідомлень підряд — це ОДНА відповідь (читай суцільно, не як окремі репліки):\n1) Привіт\n2) Хочу стрижку';
    expect(unwrapCoalescePreamble(raw)).toBe('Привіт\nХочу стрижку');
  });

  it('flags agent and vision debug as service notes', () => {
    expect(isHandoffServiceNote(`${AGENT_TURN_DEBUG_PREFIX}\n• Режим: sales`)).toBe(
      true,
    );
    expect(isHandoffServiceNote(`${VISION_DEBUG_PREFIX}\n• Vision: 1`)).toBe(true);
    expect(isHandoffServiceNote('Хочу бокс', 'client')).toBe(false);
    expect(isHandoffServiceNote('ok', 'system')).toBe(true);
  });

  it('drops debug, reactions, and coalesce wrapper from manager-facing lines', () => {
    const lines = selectManagerFacingHandoffLines([
      { sender: 'client', text: 'Хочу записатись', isVoice: false },
      { sender: 'system', text: `${AGENT_TURN_DEBUG_PREFIX}\n• Режим: sales`, isVoice: false },
      { sender: 'client', text: 'Реакція ❤️', isVoice: false },
      {
        sender: 'client',
        text: 'Клієнт надіслав кілька повідомлень підряд — це ОДНА відповідь (читай суцільно, не як окремі репліки):\n1) Бачила пост',
        isVoice: false,
      },
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Хочу записатись', 'Бачила пост']);
  });

  it('keeps service notes separately for private bot DMs', () => {
    const notes = selectHandoffServiceNotes([
      { sender: 'client', text: 'Привіт', isVoice: false },
      { sender: 'system', text: `${AGENT_TURN_DEBUG_PREFIX}\nRounds:`, isVoice: false },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain(AGENT_TURN_DEBUG_PREFIX);
  });
});
