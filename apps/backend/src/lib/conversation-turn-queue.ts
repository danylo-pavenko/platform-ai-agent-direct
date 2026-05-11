/**
 * Serializes bot turns per conversation so parallel webhook deliveries /
 * racing handlers cannot each send and persist a full duplicate reply.
 */

const tails = new Map<string, Promise<unknown>>();

export function runConversationTurnSerialized<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(conversationId) ?? Promise.resolve();
  const result = prev.catch(() => {}).then(() => fn());
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(conversationId, tail);
  return result;
}
