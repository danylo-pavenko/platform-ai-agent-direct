import { describe, expect, it } from 'vitest';
import { visibleMetaAgentStreamText } from './meta-agent-stream-display';
import { resolveTeachStreamClose } from './teach-stream-close';

describe('visibleMetaAgentStreamText', () => {
  it('keeps plain reply text', () => {
    expect(visibleMetaAgentStreamText('Зробив тон коротшим.')).toBe('Зробив тон коротшим.');
  });

  it('hides fenced JSON payload', () => {
    const raw = `Додав правило.\n\`\`\`json\n{\n  "reply": "Додав правило.",\n  "diffs": []\n}\n\`\`\``;
    expect(visibleMetaAgentStreamText(raw)).toBe('Додав правило.');
  });

  it('hides bare JSON starting with reply key', () => {
    const raw = 'Ок.\n{"reply":"Ок.","diffs":[]}';
    expect(visibleMetaAgentStreamText(raw)).toBe('Ок.');
  });
});

describe('resolveTeachStreamClose partial recovery', () => {
  it('is partial_ok when text arrived without done', () => {
    expect(
      resolveTeachStreamClose({
        gotDone: false,
        gotError: false,
        aborted: false,
        gotPartialText: true,
      }),
    ).toBe('partial_ok');
  });

  it('stays silent_end without text', () => {
    expect(
      resolveTeachStreamClose({
        gotDone: false,
        gotError: false,
        aborted: false,
        gotPartialText: false,
      }),
    ).toBe('silent_end');
  });
});
