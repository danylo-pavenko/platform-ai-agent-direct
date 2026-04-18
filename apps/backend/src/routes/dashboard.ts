import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

const PERIODS = ['24h', '7d', '30d', '90d', 'all'] as const;
type Period = (typeof PERIODS)[number];

function parsePeriod(q: string | undefined): Period {
  const v = (q ?? '7d').toLowerCase();
  return PERIODS.includes(v as Period) ? (v as Period) : '7d';
}

function periodStart(period: Period): Date | null {
  if (period === 'all') return null;
  const now = Date.now();
  const day = 86400000;
  switch (period) {
    case '24h':
      return new Date(now - day);
    case '7d':
      return new Date(now - 7 * day);
    case '30d':
      return new Date(now - 30 * day);
    case '90d':
      return new Date(now - 90 * day);
    default:
      return new Date(now - 7 * day);
  }
}

/** Distinct clients who sent at least one inbound message in the window. */
async function countClientsContacted(from: Date | null): Promise<number> {
  if (!from) {
    const [row] = await prisma.$queryRaw<[{ n: bigint }]>`
      SELECT COUNT(DISTINCT c.client_id)::bigint AS n
      FROM messages m
      INNER JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender = 'client' AND m.direction = 'in'
    `;
    return Number(row.n);
  }
  const [row] = await prisma.$queryRaw<[{ n: bigint }]>`
    SELECT COUNT(DISTINCT c.client_id)::bigint AS n
    FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE m.sender = 'client' AND m.direction = 'in' AND m.created_at >= ${from}
  `;
  return Number(row.n);
}

async function countBotOutbound(from: Date | null): Promise<number> {
  return prisma.message.count({
    where: {
      sender: 'bot',
      direction: 'out',
      ...(from ? { createdAt: { gte: from } } : {}),
    },
  });
}

async function countConversationsActive(from: Date | null): Promise<number> {
  return prisma.conversation.count({
    where: from ? { lastMessageAt: { gte: from } } : {},
  });
}

/** Threads currently in handoff with recent activity (proxy for manager queue). */
async function countHandoffConversations(from: Date | null): Promise<number> {
  return prisma.conversation.count({
    where: {
      state: 'handoff',
      ...(from ? { lastMessageAt: { gte: from } } : {}),
    },
  });
}

async function countOrdersByStatus(
  from: Date | null,
  statuses: Array<'draft' | 'submitted' | 'confirmed' | 'cancelled'>,
): Promise<number> {
  return prisma.order.count({
    where: {
      status: { in: statuses },
      ...(from ? { createdAt: { gte: from } } : {}),
    },
  });
}

async function countOrdersSubmittedToManager(from: Date | null): Promise<number> {
  return prisma.order.count({
    where: {
      submittedToManagerAt: { not: null },
      ...(from ? { submittedToManagerAt: { gte: from } } : {}),
    },
  });
}

type DayRow = { day: Date; bot_out: bigint; client_in: bigint };

async function loadDailySeries(seriesFrom: Date): Promise<DayRow[]> {
  return prisma.$queryRaw<DayRow[]>`
    SELECT date_trunc('day', m.created_at AT TIME ZONE 'UTC') AS day,
           COUNT(*) FILTER (WHERE m.sender = 'bot' AND m.direction = 'out')::bigint AS bot_out,
           COUNT(*) FILTER (WHERE m.sender = 'client' AND m.direction = 'in')::bigint AS client_in
    FROM messages m
    WHERE m.created_at >= ${seriesFrom}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { period?: string };
  }>('/summary', { onRequest: [app.authenticate] }, async (request) => {
    const period = parsePeriod(request.query.period);
    const from = periodStart(period);
    const now = new Date();

    const seriesDays = period === 'all' ? 90 : period === '24h' ? 2 : period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const seriesFrom = new Date(now.getTime() - seriesDays * 86400000);

    const [
      clientsContacted,
      botReplies,
      conversationsActive,
      handoffConversations,
      ordersDraft,
      ordersSubmitted,
      ordersConfirmed,
      ordersCancelled,
      ordersSentToManager,
      lastBotMessage,
      lastSyncOk,
      totalConversations,
      dailyRows,
    ] = await Promise.all([
      countClientsContacted(from),
      countBotOutbound(from),
      countConversationsActive(from),
      countHandoffConversations(from),
      countOrdersByStatus(from, ['draft']),
      countOrdersByStatus(from, ['submitted']),
      countOrdersByStatus(from, ['confirmed']),
      countOrdersByStatus(from, ['cancelled']),
      countOrdersSubmittedToManager(from),
      prisma.message.findFirst({
        where: { sender: 'bot', direction: 'out' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.keycrmSyncRun.findFirst({
        where: { status: 'ok' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, startedAt: true },
      }),
      prisma.conversation.count(),
      loadDailySeries(seriesFrom),
    ]);

    const ordersInPipeline = ordersSubmitted + ordersConfirmed;

    const series = dailyRows.map((r) => ({
      date: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
      botReplies: Number(r.bot_out),
      clientMessages: Number(r.client_in),
    }));

    return {
      period,
      from: from?.toISOString() ?? null,
      to: now.toISOString(),
      totals: {
        clientsContacted,
        botReplies,
        conversationsActive,
        handoffConversations,
        ordersDraft,
        ordersSubmitted,
        ordersConfirmed,
        ordersInPipeline,
        ordersCancelled,
        ordersSentToManager,
        totalConversations,
      },
      health: {
        lastBotReplyAt: lastBotMessage?.createdAt.toISOString() ?? null,
        lastCatalogSyncAt: lastSyncOk?.finishedAt?.toISOString() ?? lastSyncOk?.startedAt.toISOString() ?? null,
        /** Bot replied at least once in the selected window. */
        botActiveInPeriod: botReplies > 0,
        /** Last bot message within 48h (quick pulse). */
        botRecentlyActive: lastBotMessage
          ? Date.now() - lastBotMessage.createdAt.getTime() < 48 * 3600000
          : false,
      },
      series,
    };
  });
}
