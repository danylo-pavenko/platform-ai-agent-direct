import pino from 'pino';
import { prisma } from './prisma.js';
import {
  DEFAULT_HANDOFF_RETURN_TO_BOT_MINUTES,
  getHandoffReturnToBotMinutes,
} from './handoff-settings.js';

const log = pino({ name: 'handoff-auto-return' });

type HandoffTimingConversation = {
  id: string;
  state: string;
  handedOffAt: Date | null;
  lastMessageAt: Date | null;
  createdAt: Date;
};

export function effectiveHandoffStartedAt(conversation: {
  handedOffAt: Date | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}): Date {
  return conversation.handedOffAt ?? conversation.lastMessageAt ?? conversation.createdAt;
}

/** Idle timer starts at handoff, or last manager reply if later. */
export async function getHandoffIdleStartedAt(
  conversation: HandoffTimingConversation,
): Promise<Date> {
  const handedOff = effectiveHandoffStartedAt(conversation);
  const lastManager = await prisma.message.findFirst({
    where: { conversationId: conversation.id, sender: 'manager' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!lastManager) return handedOff;
  return lastManager.createdAt > handedOff ? lastManager.createdAt : handedOff;
}

export function isHandoffIdleExpiredAt(
  idleStartedAt: Date,
  timeoutMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  if (timeoutMinutes <= 0) return false;
  return nowMs - idleStartedAt.getTime() >= timeoutMinutes * 60_000;
}

export function isHandoffIdleExpired(
  conversation: {
    handedOffAt: Date | null;
    lastMessageAt: Date | null;
    createdAt: Date;
  },
  timeoutMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  return isHandoffIdleExpiredAt(effectiveHandoffStartedAt(conversation), timeoutMinutes, nowMs);
}

/**
 * If handoff idle timeout elapsed, return the conversation to the bot.
 * @returns true when state was switched back to `bot`.
 */
export async function autoReturnHandoffToBotIfExpired(
  conversation: HandoffTimingConversation,
): Promise<boolean> {
  if (conversation.state !== 'handoff') return false;

  const timeoutMinutes = await getHandoffReturnToBotMinutes();
  if (timeoutMinutes <= 0) return false;

  const idleStartedAt = await getHandoffIdleStartedAt(conversation);
  if (!isHandoffIdleExpiredAt(idleStartedAt, timeoutMinutes)) return false;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      state: 'bot',
      handedOffTo: null,
      handedOffAt: null,
      handoffReason: null,
    },
  });

  log.info(
    {
      conversationId: conversation.id,
      timeoutMinutes: timeoutMinutes || DEFAULT_HANDOFF_RETURN_TO_BOT_MINUTES,
      handedOffAt: conversation.handedOffAt?.toISOString() ?? null,
    },
    'Handoff idle timeout — conversation returned to bot',
  );

  return true;
}
