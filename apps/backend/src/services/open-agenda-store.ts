import pino from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import {
  freshOpenAgenda,
  parseOpenAgenda,
  type OpenAgenda,
} from '../lib/open-agenda.js';

const log = pino({ name: 'open-agenda-store' });

export async function loadFreshOpenAgenda(
  conversationId: string,
  now = new Date(),
): Promise<OpenAgenda | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { openAgenda: true },
  });
  return freshOpenAgenda(row?.openAgenda, now);
}

export async function loadParsedOpenAgenda(
  conversationId: string,
): Promise<OpenAgenda | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { openAgenda: true },
  });
  return parseOpenAgenda(row?.openAgenda);
}

export async function persistOpenAgenda(
  conversationId: string,
  agenda: OpenAgenda | null,
): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        openAgenda: agenda ? (toInputJsonValue(agenda) ?? Prisma.DbNull) : Prisma.DbNull,
      },
    });
  } catch (err) {
    log.warn({ err, conversationId }, 'Failed to persist open agenda');
  }
}

export async function clearConversationOpenAgenda(conversationId: string): Promise<void> {
  await persistOpenAgenda(conversationId, null);
}
