/**
 * Customer-facing text when `request_handoff` ends the turn.
 *
 * Claude's free-text reply is often notes for the manager (or mixed). Only
 * send that reply to Instagram when the tool explicitly sets
 * `show_to_client: true`. Otherwise always use the canned connect line —
 * `reason` still goes to Telegram.
 */

export const DEFAULT_HANDOFF_CLIENT_MESSAGE =
  'Зачекайте, будь ласка, зʼєдную Вас з менеджером.';

export type ResolveHandoffClientMessageInput = {
  agentText?: string | null;
  /** From `request_handoff.show_to_client`. Must be true to use agentText. */
  showToClient?: boolean | null;
};

/**
 * Use Claude's reply only when `showToClient` is true and the text is non-empty.
 * Otherwise the platform fallback (manager notes must not leak to IG).
 */
export function resolveHandoffClientMessage(
  input?: ResolveHandoffClientMessageInput | string | null,
): string {
  // Legacy: bare string = always prefer non-empty (tests / old callers).
  if (typeof input === 'string' || input == null) {
    const trimmed = typeof input === 'string' ? input.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_HANDOFF_CLIENT_MESSAGE;
  }

  if (input.showToClient !== true) {
    return DEFAULT_HANDOFF_CLIENT_MESSAGE;
  }
  const trimmed = typeof input.agentText === 'string' ? input.agentText.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_HANDOFF_CLIENT_MESSAGE;
}

/** Coerce tool arg: only explicit boolean true opts in. */
export function parseHandoffShowToClient(value: unknown): boolean {
  return value === true;
}
