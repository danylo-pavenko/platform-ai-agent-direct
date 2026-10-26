/**
 * Customer-facing text when `request_handoff` ends the turn.
 *
 * Prefer Claude's reply from the same turn (tenant temporary rules, SMM/UGC,
 * named assistant, etc.). Only use the canned connect line when the model
 * called the tool with empty/whitespace text.
 */

export const DEFAULT_HANDOFF_CLIENT_MESSAGE =
  'Зачекайте, будь ласка, зʼєдную Вас з менеджером.';

/** Prefer non-empty agent reply; otherwise the platform fallback. */
export function resolveHandoffClientMessage(agentText?: string | null): string {
  const trimmed = typeof agentText === 'string' ? agentText.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_HANDOFF_CLIENT_MESSAGE;
}
