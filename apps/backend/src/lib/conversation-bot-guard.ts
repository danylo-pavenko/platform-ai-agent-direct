import { prisma } from './prisma.js';

/**
 * Returns false when a human manager has taken over or replied since the bot
 * turn started — the in-flight Claude response must not send IG messages or
 * create orders.
 */
export async function isBotTurnStillValid(
  conversationId: string,
  turnStartedAt: Date,
): Promise<boolean> {
  const [conversation, managerIntervention] = await Promise.all([
    prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { state: true },
    }),
    prisma.message.findFirst({
      where: {
        conversationId,
        sender: 'manager',
        createdAt: { gte: turnStartedAt },
      },
      select: { id: true },
    }),
  ]);

  if (!conversation || conversation.state !== 'bot') return false;
  if (managerIntervention) return false;
  return true;
}
