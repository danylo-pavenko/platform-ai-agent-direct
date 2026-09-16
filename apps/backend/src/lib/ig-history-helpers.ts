export const MAX_IG_HISTORY_MESSAGES = 200;
/** Instagram Conversations API typically exposes ~20 recent message bodies. */
export const FIRST_CONTACT_IG_HISTORY_LIMIT = 20;
export const FIRST_CONTACT_IMPORT_TIMEOUT_MS = 12_000;

export function clampIgHistoryLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return MAX_IG_HISTORY_MESSAGES;
  return Math.max(1, Math.min(MAX_IG_HISTORY_MESSAGES, Math.floor(limit)));
}

export function isOwnIgHistorySender(
  senderId: string,
  ownIds: Array<string | null | undefined>,
): boolean {
  return ownIds.some((id) => typeof id === 'string' && id.length > 0 && id === senderId);
}
