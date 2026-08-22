import { describe, expect, it } from 'vitest';
import { createTurnClaudeSessions } from './turn-claude-sessions.js';

describe('createTurnClaudeSessions', () => {
  it('reuses one session across follow-up rounds', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('sess-1');
    expect(s.resumeId()).toBe('sess-1');
    s.noteSuccess('sess-1');
    expect(s.resumeId()).toBe('sess-1');
    expect(s.sessionId).toBe('sess-1');
  });

  it('clears the session on fallback so the next spawn is cold', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('sess-1');
    s.noteFallback();
    expect(s.resumeId()).toBeUndefined();
  });

  it('clearAll wipes the session and aborts the previous signal', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('sess-1');
    const previous = s.signal;
    s.clearAll();
    expect(s.resumeId()).toBeUndefined();
    expect(previous.aborted).toBe(true);
    expect(s.signal.aborted).toBe(false);
    expect(s.signal).not.toBe(previous);
  });

  it('abortInflight keeps resume id and issues a fresh signal', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('sess-1');
    const previous = s.signal;
    s.abortInflight();
    expect(s.resumeId()).toBe('sess-1');
    expect(previous.aborted).toBe(true);
    expect(s.signal.aborted).toBe(false);
  });

  it('noteSuccess ignores empty session ids', () => {
    const s = createTurnClaudeSessions();
    s.noteSuccess('  ');
    expect(s.resumeId()).toBeUndefined();
  });
});
