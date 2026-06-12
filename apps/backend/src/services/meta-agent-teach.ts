import { prisma } from '../lib/prisma.js';

/** Max user turns per session before starting a new one (~15 exchanges). */
export const TEACH_SESSION_EXCHANGE_LIMIT = 15;

/** Warn in the UI when this many user turns are reached. */
export const TEACH_SESSION_WARN_EXCHANGES = 12;

/** Max prior messages passed to Claude as conversation history. */
export const TEACH_CLAUDE_HISTORY_LIMIT = 30;

export interface TeachChatMessage {
  role: 'user' | 'assistant';
  content: string;
  suggestedDiffs?: Array<{ before: string; after: string; summary: string }>;
  createdAt: string;
}

export interface TeachSessionPayload {
  id: string;
  title: string | null;
  isActive: boolean;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  exchangeCount: number;
  contextLimit: number;
  contextWarnAt: number;
  contextFull: boolean;
  contextNearFull: boolean;
  messages: TeachChatMessage[];
}

function countUserExchanges(messages: Array<{ role: string }>): number {
  return messages.filter((m) => m.role === 'user').length;
}

function sessionTitleFromMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 60) return oneLine;
  return `${oneLine.slice(0, 57)}...`;
}

function mapMessages(
  rows: Array<{
    role: 'user' | 'assistant';
    content: string;
    suggestedDiffs: unknown;
    createdAt: Date;
  }>,
): TeachChatMessage[] {
  return rows.map((m) => ({
    role: m.role,
    content: m.content,
    ...(Array.isArray(m.suggestedDiffs) && m.suggestedDiffs.length > 0
      ? { suggestedDiffs: m.suggestedDiffs as TeachChatMessage['suggestedDiffs'] }
      : {}),
    createdAt: m.createdAt.toISOString(),
  }));
}

function buildSessionPayload(
  session: {
    id: string;
    title: string | null;
    isActive: boolean;
    createdAt: Date;
    lastMessageAt: Date | null;
    messages: Array<{
      role: 'user' | 'assistant';
      content: string;
      suggestedDiffs: unknown;
      createdAt: Date;
    }>;
  },
): TeachSessionPayload {
  const messageCount = session.messages.length;
  const exchangeCount = countUserExchanges(session.messages);
  return {
    id: session.id,
    title: session.title,
    isActive: session.isActive,
    createdAt: session.createdAt.toISOString(),
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    messageCount,
    exchangeCount,
    contextLimit: TEACH_SESSION_EXCHANGE_LIMIT,
    contextWarnAt: TEACH_SESSION_WARN_EXCHANGES,
    contextFull: exchangeCount >= TEACH_SESSION_EXCHANGE_LIMIT,
    contextNearFull:
      exchangeCount >= TEACH_SESSION_WARN_EXCHANGES
      && exchangeCount < TEACH_SESSION_EXCHANGE_LIMIT,
    messages: mapMessages(session.messages),
  };
}

const sessionInclude = {
  messages: { orderBy: { createdAt: 'asc' as const } },
} as const;

export async function getOrCreateActiveTeachSession(adminUserId: string): Promise<TeachSessionPayload> {
  let session = await prisma.metaAgentTeachSession.findFirst({
    where: { adminUserId, isActive: true },
    include: sessionInclude,
  });

  if (!session) {
    session = await prisma.metaAgentTeachSession.create({
      data: { adminUserId, isActive: true },
      include: sessionInclude,
    });
  }

  return buildSessionPayload(session);
}

export async function startNewTeachSession(adminUserId: string): Promise<TeachSessionPayload> {
  await prisma.$transaction(async (tx) => {
    await tx.metaAgentTeachSession.updateMany({
      where: { adminUserId, isActive: true },
      data: { isActive: false, closedAt: new Date() },
    });
    await tx.metaAgentTeachSession.create({
      data: { adminUserId, isActive: true },
    });
  });

  return getOrCreateActiveTeachSession(adminUserId);
}

export async function getTeachSessionById(
  sessionId: string,
  adminUserId: string,
): Promise<TeachSessionPayload | null> {
  const session = await prisma.metaAgentTeachSession.findFirst({
    where: { id: sessionId, adminUserId },
    include: sessionInclude,
  });
  if (!session) return null;
  return buildSessionPayload(session);
}

export function buildClaudeHistoryFromMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.slice(-TEACH_CLAUDE_HISTORY_LIMIT);
}

export async function appendTeachUserMessage(
  sessionId: string,
  adminUserId: string,
  content: string,
): Promise<{ session: TeachSessionPayload; priorMessages: TeachChatMessage[]; userMessageId: string }> {
  const session = await prisma.metaAgentTeachSession.findFirst({
    where: { id: sessionId, adminUserId, isActive: true },
    include: sessionInclude,
  });

  if (!session) {
    throw new Error('SESSION_NOT_FOUND');
  }

  if (countUserExchanges(session.messages) >= TEACH_SESSION_EXCHANGE_LIMIT) {
    throw new Error('CONTEXT_FULL');
  }

  const priorMessages = mapMessages(session.messages);

  const userRow = await prisma.metaAgentTeachMessage.create({
    data: {
      sessionId: session.id,
      role: 'user',
      content,
    },
  });

  const title = session.title ?? sessionTitleFromMessage(content);

  await prisma.metaAgentTeachSession.update({
    where: { id: session.id },
    data: {
      title,
      lastMessageAt: new Date(),
    },
  });

  const updated = await prisma.metaAgentTeachSession.findUniqueOrThrow({
    where: { id: session.id },
    include: sessionInclude,
  });

  return {
    session: buildSessionPayload(updated),
    priorMessages,
    userMessageId: userRow.id,
  };
}

export async function appendTeachAssistantMessage(
  sessionId: string,
  content: string,
  suggestedDiffs?: Array<{ before: string; after: string; summary: string }>,
): Promise<TeachSessionPayload> {
  await prisma.metaAgentTeachMessage.create({
    data: {
      sessionId,
      role: 'assistant',
      content,
      suggestedDiffs: suggestedDiffs?.length ? suggestedDiffs : undefined,
    },
  });

  await prisma.metaAgentTeachSession.update({
    where: { id: sessionId },
    data: { lastMessageAt: new Date() },
  });

  const updated = await prisma.metaAgentTeachSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: sessionInclude,
  });

  return buildSessionPayload(updated);
}
