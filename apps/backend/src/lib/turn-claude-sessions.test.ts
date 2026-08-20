import { describe, expect, it } from 'vitest';
import { createTurnClaudeSessions } from './turn-claude-sessions.js';

describe('createTurnClaudeSessions', () => {
  it('keeps reply and router sessions independent', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', 'reply-1');
    s.noteSuccess('router', 'router-1');
    expect(s.resumeIdFor('reply')).toBe('reply-1');
    expect(s.resumeIdFor('router')).toBe('router-1');
  });

  it('does not wipe reply when router falls back', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', 'reply-1');
    s.noteSuccess('router', 'router-1');
    s.noteFallback('router');
    expect(s.resumeIdFor('reply')).toBe('reply-1');
    expect(s.resumeIdFor('router')).toBeUndefined();
  });

  it('clearAll wipes both', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', 'r');
    s.noteSuccess('router', 'h');
    s.clearAll();
    expect(s.resumeIdFor('reply')).toBeUndefined();
    expect(s.resumeIdFor('router')).toBeUndefined();
  });

  it('noteSuccess ignores empty session ids', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', '  ');
    expect(s.resumeIdFor('reply')).toBeUndefined();
  });
});
