import { describe, expect, it } from 'vitest';
import { mergeMessageTextWithTranscripts } from './voice-ingest.js';

describe('mergeMessageTextWithTranscripts', () => {
  it('merges typed caption and voice transcript', () => {
    const merged = mergeMessageTextWithTranscripts('Дивись', [
      {
        kind: 'audio',
        igType: 'audio',
        status: 'ready',
        transcript: 'Це голосове',
      },
    ]);
    expect(merged).toBe('Дивись\nЦе голосове');
  });

  it('returns transcript only for voice-only messages', () => {
    const merged = mergeMessageTextWithTranscripts('', [
      {
        kind: 'audio',
        igType: 'audio',
        status: 'ready',
        transcript: 'Хочу записатися',
      },
    ]);
    expect(merged).toBe('Хочу записатися');
  });

  it('ignores audio without transcript', () => {
    expect(
      mergeMessageTextWithTranscripts('', [
        { kind: 'audio', igType: 'audio', status: 'ready', sttStatus: 'failed' },
      ]),
    ).toBe('');
  });
});
