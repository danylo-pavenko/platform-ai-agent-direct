import { prisma } from '../lib/prisma.js';

/**
 * Soft exchange budget: after this many user turns we compact older messages
 * into sessionSummary instead of hard-blocking with CONTEXT_FULL.
 */
export const TEACH_SESSION_EXCHANGE_LIMIT = 40;

/** Warn in the UI when this many user turns are reached. */
export const TEACH_SESSION_WARN_EXCHANGES = 30;

/** Compact when exchange count reaches this (keep last N messages). */
export const TEACH_COMPACT_AT_EXCHANGES = 28;

/** After compact, keep this many newest messages in the session transcript. */
export const TEACH_KEEP_MESSAGES_AFTER_COMPACT = 16;

/** Max prior messages passed to Claude as conversation history. */
export const TEACH_CLAUDE_HISTORY_LIMIT = 24;

export interface TeachChatMessage {
  role: 'user' | 'assistant';
  content: string;
  suggestedDiffs?: Array<{ before: string; after: string; summary: string }>;
  createdAt: string;
}

export interface TeachSessionPayload {
  id: string;
  title: string | null;
  sessionSummary: string | null;
  isActive: boolean;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  exchangeCount: number;
  contextLimit: number;
  contextWarnAt: number;
  /** Always false with soft compact — kept for UI compat. */
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
    sessionSummary?: string | null;
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
    sessionSummary: session.sessionSummary ?? null,
    isActive: session.isActive,
    createdAt: session.createdAt.toISOString(),
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    messageCount,
    exchangeCount,
    contextLimit: TEACH_SESSION_EXCHANGE_LIMIT,
    contextWarnAt: TEACH_SESSION_WARN_EXCHANGES,
    contextFull: false,
    contextNearFull: exchangeCount >= TEACH_SESSION_WARN_EXCHANGES,
    messages: mapMessages(session.messages),
  };
}

const sessionInclude = {
  messages: { orderBy: { createdAt: 'asc' as const } },
} as const;

function buildCompactSummary(
  previousSummary: string | null | undefined,
  dropped: TeachChatMessage[],
): string {
  const lines: string[] = [];
  if (previousSummary?.trim()) {
    lines.push(previousSummary.trim());
  }
  for (const m of dropped) {
    if (m.role === 'user') {
      lines.push(`Адмін: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    } else if (m.suggestedDiffs && m.suggestedDiffs.length > 0) {
      for (const d of m.suggestedDiffs) {
        lines.push(`Рішення: ${d.summary || d.after.slice(0, 120)}`);
      }
    } else {
      lines.push(`Мета-агент: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    }
  }
  const joined = lines.join('\n').trim();
  return joined.length > 4000 ? `${joined.slice(0, 3997)}...` : joined;
}

/**
 * When the session grows long, fold older messages into sessionSummary and
 * delete them so Claude context stays lean.
 */
export async function maybeCompactTeachSession(sessionId: string): Promise<void> {
  const session = await prisma.metaAgentTeachSession.findUnique({
    where: { id: sessionId },
    include: sessionInclude,
  });
  if (!session) return;

  const exchangeCount = countUserExchanges(session.messages);
  if (
    exchangeCount < TEACH_COMPACT_AT_EXCHANGES
    || session.messages.length <= TEACH_KEEP_MESSAGES_AFTER_COMPACT
  ) {
    return;
  }

  const keep = session.messages.slice(-TEACH_KEEP_MESSAGES_AFTER_COMPACT);
  const drop = session.messages.slice(0, session.messages.length - keep.length);
  if (drop.length === 0) return;

  const summary = buildCompactSummary(
    session.sessionSummary,
    mapMessages(drop),
  );

  await prisma.$transaction(async (tx) => {
    await tx.metaAgentTeachMessage.deleteMany({
      where: { id: { in: drop.map((m) => m.id) } },
    });
    await tx.metaAgentTeachSession.update({
      where: { id: sessionId },
      data: { sessionSummary: summary },
    });
  });
}

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
  sessionSummary?: string | null,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const tail = messages.slice(-TEACH_CLAUDE_HISTORY_LIMIT);
  if (!sessionSummary?.trim()) return tail;
  return [
    {
      role: 'assistant',
      content: `[Підсумок попередніх рішень сесії]\n${sessionSummary.trim()}`,
    },
    ...tail,
  ];
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

  await maybeCompactTeachSession(session.id);

  const refreshed = await prisma.metaAgentTeachSession.findUniqueOrThrow({
    where: { id: session.id },
    include: sessionInclude,
  });

  const priorMessages = mapMessages(refreshed.messages);

  const userRow = await prisma.metaAgentTeachMessage.create({
    data: {
      sessionId: refreshed.id,
      role: 'user',
      content,
    },
  });

  const title = refreshed.title ?? sessionTitleFromMessage(content);

  await prisma.metaAgentTeachSession.update({
    where: { id: refreshed.id },
    data: {
      title,
      lastMessageAt: new Date(),
    },
  });

  const updated = await prisma.metaAgentTeachSession.findUniqueOrThrow({
    where: { id: refreshed.id },
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
