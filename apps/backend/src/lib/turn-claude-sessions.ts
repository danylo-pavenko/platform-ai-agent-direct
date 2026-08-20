/**
 * Per-turn Claude Code sessions: reply model and Haiku router keep separate
 * `--resume` ids so switching models does not force a cold full prompt.
 */

export type TurnClaudePurpose = 'reply' | 'router';

export type TurnClaudeSessions = {
  replySessionId: string | undefined;
  routerSessionId: string | undefined;
  clearAll: () => void;
  /** Session id to pass as resumeSessionId for this purpose (undefined = cold). */
  resumeIdFor: (purpose: TurnClaudePurpose) => string | undefined;
  /** After a successful spawn — store session for that purpose only. */
  noteSuccess: (purpose: TurnClaudePurpose, sessionId: string | undefined) => void;
  /** Fallback / unusable result — clear that purpose session (or both if unknown). */
  noteFallback: (purpose?: TurnClaudePurpose) => void;
};

export function createTurnClaudeSessions(): TurnClaudeSessions {
  let replySessionId: string | undefined;
  let routerSessionId: string | undefined;

  return {
    get replySessionId() {
      return replySessionId;
    },
    get routerSessionId() {
      return routerSessionId;
    },
    clearAll() {
      replySessionId = undefined;
      routerSessionId = undefined;
    },
    resumeIdFor(purpose) {
      return purpose === 'router' ? routerSessionId : replySessionId;
    },
    noteSuccess(purpose, sessionId) {
      const id = sessionId?.trim() || undefined;
      if (!id) return;
      if (purpose === 'router') routerSessionId = id;
      else replySessionId = id;
    },
    noteFallback(purpose) {
      if (purpose === 'router') {
        routerSessionId = undefined;
        return;
      }
      if (purpose === 'reply') {
        replySessionId = undefined;
        return;
      }
      replySessionId = undefined;
      routerSessionId = undefined;
    },
  };
}
