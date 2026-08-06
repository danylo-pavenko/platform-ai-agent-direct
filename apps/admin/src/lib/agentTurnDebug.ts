/** Mirrors backend `AGENT_TURN_DEBUG_PREFIX` — admin-only turn debug system notes. */
export const AGENT_TURN_DEBUG_PREFIX = '🛠 Хід агента';

export function isAgentTurnDebugNote(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.startsWith(AGENT_TURN_DEBUG_PREFIX);
}
