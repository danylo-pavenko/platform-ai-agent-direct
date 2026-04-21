/**
 * conversation-metrics.ts — small helpers for time-to-first-response tracking.
 *
 * `firstInboundAt` is stamped once in webhooks.ts when the first inbound
 * message for a conversation is persisted. `firstOutboundAt` is stamped
 * the first time *anyone* (bot, manager, order confirmation) sends a
 * message back, through `markFirstOutboundAt`.
 *
 * Using updateMany with a `firstOutboundAt: null` filter gives us
 * set-if-null semantics in a single round-trip — no read-then-write race.
 */
import { prisma } from './prisma.js';

export async function markFirstOutboundAt(
  conversationId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.conversation.updateMany({
    where: { id: conversationId, firstOutboundAt: null },
    data: { firstOutboundAt: at },
  });
}
