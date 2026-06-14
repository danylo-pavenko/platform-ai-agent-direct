import { describe, expect, it } from 'vitest';
import { formatHandoffMessageLine } from './handoff-format.js';

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
