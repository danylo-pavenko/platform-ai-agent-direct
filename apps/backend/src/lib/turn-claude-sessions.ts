/**
 * Per-turn Claude Code session for the tenant reply model (sonnet|opus).
 * First spawn is cold; tool follow-ups `--resume` the same id so a multi-item
 * order across tool rounds stays in one thread.
 * Mid-turn prompt activate clears the id and aborts in-flight Claude.
 */

export type TurnClaudeSessions = {
  sessionId: string | undefined;
  /** AbortSignal for the current in-flight Claude call of this turn. */
  readonly signal: AbortSignal;
  clearAll: () => void;
  /** Abort in-flight Claude (sandbox disconnect). Does not wipe resume id. */
  abortInflight: () => void;
  /** Session id to pass as resumeSessionId (undefined = cold). */
  resumeId: () => string | undefined;
  /** After a successful spawn — store session for later rounds. */
  noteSuccess: (sessionId: string | undefined) => void;
  /** Fallback / unusable result — clear the session so the next spawn is cold. */
  noteFallback: () => void;
};

export function createTurnClaudeSessions(): TurnClaudeSessions {
  let sessionId: string | undefined;
  let abort = new AbortController();

  const abortInflight = () => {
    if (!abort.signal.aborted) abort.abort();
    abort = new AbortController();
  };

  return {
    get sessionId() {
      return sessionId;
    },
    get signal() {
      return abort.signal;
    },
    abortInflight,
    clearAll() {
      sessionId = undefined;
      abortInflight();
    },
    resumeId() {
      return sessionId;
    },
    noteSuccess(id) {
      const next = id?.trim() || undefined;
      if (!next) return;
      sessionId = next;
    },
    noteFallback() {
      sessionId = undefined;
    },
  };
}
