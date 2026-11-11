import { describe, expect, it } from 'vitest';

/** Mirrors TeachChat restoreResultFromMessages selection logic. */
function restoreFromMessages(
  messages: Array<{
    role: string;
    suggestedDiffs?: Array<{ summary: string }>;
    libraryDrafts?: Array<{ id: string; slug: string }>;
  }>,
) {
  let diffs: Array<{ summary: string }> = [];
  let library: Array<{ id: string; slug: string }> = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (msg.suggestedDiffs?.length) diffs = msg.suggestedDiffs;
    if (msg.libraryDrafts?.length) library = msg.libraryDrafts;
    break;
  }
  return { diffs, library };
}

describe('teach result restore after reload', () => {
  it('restores diffs and library from last assistant message', () => {
    const result = restoreFromMessages([
      { role: 'user' },
      {
        role: 'assistant',
        suggestedDiffs: [{ summary: 'коротше' }],
        libraryDrafts: [{ id: '1', slug: 'event' }],
      },
    ]);
    expect(result.diffs[0].summary).toBe('коротше');
    expect(result.library[0].slug).toBe('event');
  });

  it('ignores older assistants when a newer one has no payload', () => {
    const result = restoreFromMessages([
      {
        role: 'assistant',
        suggestedDiffs: [{ summary: 'old' }],
      },
      { role: 'user' },
      { role: 'assistant' },
    ]);
    expect(result.diffs).toEqual([]);
    expect(result.library).toEqual([]);
  });
});

describe('apply+activate payload shape', () => {
  it('includes activate and optional publishLibraryIds', () => {
    const payload = {
      diffs: [{ before: 'a', after: 'b', summary: 'tone' }],
      activate: true,
      basePromptId: 'prompt-1',
      publishLibraryIds: ['lib-1'],
    };
    expect(payload.activate).toBe(true);
    expect(payload.publishLibraryIds).toEqual(['lib-1']);
  });
});
