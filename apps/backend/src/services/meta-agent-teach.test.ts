import { describe, expect, it } from 'vitest';
import {
  packTeachSuggestedPayload,
  unpackTeachSuggestedPayload,
} from './meta-agent-teach.js';

describe('pack/unpack teach suggested payload', () => {
  it('keeps legacy array when only diffs', () => {
    const packed = packTeachSuggestedPayload([
      { before: 'a', after: 'b', summary: 'tone' },
    ]);
    expect(Array.isArray(packed)).toBe(true);
    const unpacked = unpackTeachSuggestedPayload(packed);
    expect(unpacked.suggestedDiffs).toHaveLength(1);
    expect(unpacked.libraryDrafts).toBeUndefined();
  });

  it('wraps diffs + library drafts for reload restore', () => {
    const packed = packTeachSuggestedPayload(
      [{ before: '', after: 'читай read_library', summary: 'pointer' }],
      [{ id: 'id-1', slug: 'black-friday', title: 'Чорна пʼятниця' }],
    );
    expect(packed).toEqual({
      diffs: [{ before: '', after: 'читай read_library', summary: 'pointer' }],
      libraryDrafts: [{ id: 'id-1', slug: 'black-friday', title: 'Чорна пʼятниця' }],
    });
    const unpacked = unpackTeachSuggestedPayload(packed);
    expect(unpacked.suggestedDiffs?.[0].summary).toBe('pointer');
    expect(unpacked.libraryDrafts?.[0].slug).toBe('black-friday');
  });

  it('unpacks legacy array from DB', () => {
    const unpacked = unpackTeachSuggestedPayload([
      { before: 'old', after: 'new', summary: 'shorten' },
    ]);
    expect(unpacked.suggestedDiffs?.[0].after).toBe('new');
  });
});
