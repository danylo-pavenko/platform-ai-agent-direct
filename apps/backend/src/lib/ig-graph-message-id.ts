/** Graph `POST /me/messages` success JSON includes `message_id`. */
export function parseGraphSendMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const mid = (data as { message_id?: unknown }).message_id;
  return typeof mid === 'string' && mid.trim().length > 0 ? mid.trim() : null;
}
