/**
 * Telegram during manager handoff: one full escalation card, then at most
 * one follow-up with the next client message. Further inbound is admin-only.
 */

/** Initial notifyHandoff + this many client follow-ups. */
export const HANDOFF_TELEGRAM_MAX_FOLLOWUPS = 1;

/**
 * `priorClientInboundAfterHandoff` excludes the current coalesced turn.
 * 0 → this is the first client message after escalation → send follow-up.
 * ≥1 → already used the follow-up slot → skip Telegram.
 */
export function shouldNotifyHandoffFollowUp(
  priorClientInboundAfterHandoff: number,
): boolean {
  return priorClientInboundAfterHandoff < HANDOFF_TELEGRAM_MAX_FOLLOWUPS;
}
