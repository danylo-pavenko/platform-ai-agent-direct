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

  it('clearAll wipes both and aborts the previous signal', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', 'r');
    s.noteSuccess('router', 'h');
    const previous = s.signal;
    s.clearAll();
    expect(s.resumeIdFor('reply')).toBeUndefined();
    expect(s.resumeIdFor('router')).toBeUndefined();
    expect(previous.aborted).toBe(true);
    expect(s.signal.aborted).toBe(false);
    expect(s.signal).not.toBe(previous);
  });

  it('abortInflight keeps resume ids and issues a fresh signal', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', 'r');
    const previous = s.signal;
    s.abortInflight();
    expect(s.resumeIdFor('reply')).toBe('r');
    expect(previous.aborted).toBe(true);
    expect(s.signal.aborted).toBe(false);
  });

  it('noteSuccess ignores empty session ids', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('reply', '  ');
    expect(s.resumeIdFor('reply')).toBeUndefined();
  });
});
