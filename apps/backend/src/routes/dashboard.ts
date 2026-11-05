import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteReady } from '../lib/crm-write.js';
import { loadClaudeUsageSnapshot } from '../services/claude-usage-monitor.js';

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

type QualityStatsRow = {
  rated: bigint;
  avg_quality: number | null;
};

/**
 * Average manager-assigned brief quality over the window. Only counts
 * conversations that actually have `brief_quality` set — unrated threads
 * are excluded so a low sample size doesn't drag the mean artificially.
 */
async function loadQualityStats(from: Date | null): Promise<QualityStatsRow> {
  const rows = from
    ? await prisma.$queryRaw<QualityStatsRow[]>`
        SELECT
          COUNT(*)::bigint AS rated,
          AVG(brief_quality)::float8 AS avg_quality
        FROM conversations
        WHERE brief_quality IS NOT NULL
          AND last_message_at >= ${from}
      `
    : await prisma.$queryRaw<QualityStatsRow[]>`
        SELECT
          COUNT(*)::bigint AS rated,
          AVG(brief_quality)::float8 AS avg_quality
        FROM conversations
        WHERE brief_quality IS NOT NULL
      `;
  return rows[0] ?? { rated: 0n, avg_quality: null };
}

type DayRow = { day: Date; bot_out: bigint; client_in: bigint };

type BriefStatsRow = {
  total: bigint;
  high_completeness: bigint;
  avg_completeness: number | null;
  avg_confidence: number | null;
};

async function loadBriefStats(from: Date | null): Promise<BriefStatsRow> {
  // Count briefs submitted in the window and summarise completeness /
  // confidence. `completeness_pct` is always set on submit (B.1 computes
  // it synchronously in handleSubmitBrief), but we still coalesce against
  // NULL historic rows that pre-date the B.1 migration.
  const rows = from
    ? await prisma.$queryRaw<BriefStatsRow[]>`
        SELECT
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE completeness_pct >= 80)::bigint AS high_completeness,
          AVG(completeness_pct) AS avg_completeness,
          AVG(confidence) AS avg_confidence
        FROM presale_briefs
        WHERE status IN ('submitted', 'synced')
          AND created_at >= ${from}
      `
    : await prisma.$queryRaw<BriefStatsRow[]>`
        SELECT
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE completeness_pct >= 80)::bigint AS high_completeness,
          AVG(completeness_pct) AS avg_completeness,
          AVG(confidence) AS avg_confidence
        FROM presale_briefs
        WHERE status IN ('submitted', 'synced')
      `;

  return rows[0] ?? {
    total: 0n,
    high_completeness: 0n,
    avg_completeness: null,
    avg_confidence: null,
  };
}

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

type FunnelRow = {
  client_wrote: bigint;
  bot_accepted: bigint;
  bot_closed: bigint;
  handed_to_manager: bigint;
  handoff_then_closed: bigint;
  converted_from_bot: bigint;
};

/**
 * Conversation conversion funnel for the selected window.
 *
 * Cohort = conversations with ≥1 client inbound in the period.
 * Bot accepted = cohort with ≥1 bot outbound (ever).
 * Closed = distinct conversation with submitted/confirmed order
 *   or confirmed/synced appointment (booking mirrored as both counts once).
 * Bot closed = first close before handoff (or never handed off).
 * Handoff then closed = first close at/after handed_off_at.
 */
async function loadConversationFunnel(from: Date | null): Promise<FunnelRow> {
  const rows = from
    ? await prisma.$queryRaw<FunnelRow[]>`
        WITH cohort AS (
          SELECT DISTINCT c.id, c.handed_off_at
          FROM conversations c
          INNER JOIN messages m ON m.conversation_id = c.id
          WHERE m.sender = 'client'
            AND m.direction = 'in'
            AND m.created_at >= ${from}
        ),
        bot_touched AS (
          SELECT DISTINCT c.id
          FROM cohort c
          INNER JOIN messages m ON m.conversation_id = c.id
          WHERE m.sender = 'bot' AND m.direction = 'out'
        ),
        outcomes AS (
          SELECT conversation_id, MIN(created_at) AS first_closed_at
          FROM (
            SELECT conversation_id, created_at
            FROM orders
            WHERE status IN ('submitted', 'confirmed')
              AND is_archived = false
            UNION ALL
            SELECT conversation_id, created_at
            FROM appointments
            WHERE status IN ('confirmed', 'synced')
          ) u
          GROUP BY conversation_id
        )
        SELECT
          (SELECT COUNT(*)::bigint FROM cohort) AS client_wrote,
          (SELECT COUNT(*)::bigint FROM bot_touched) AS bot_accepted,
          (
            SELECT COUNT(*)::bigint
            FROM cohort c
            INNER JOIN bot_touched b ON b.id = c.id
            INNER JOIN outcomes o ON o.conversation_id = c.id
            WHERE c.handed_off_at IS NULL
               OR o.first_closed_at < c.handed_off_at
          ) AS bot_closed,
          (
            SELECT COUNT(*)::bigint
            FROM cohort c
            WHERE c.handed_off_at IS NOT NULL
          ) AS handed_to_manager,
          (
            SELECT COUNT(*)::bigint
            FROM cohort c
            INNER JOIN outcomes o ON o.conversation_id = c.id
            WHERE c.handed_off_at IS NOT NULL
              AND o.first_closed_at >= c.handed_off_at
          ) AS handoff_then_closed,
          (
            SELECT COUNT(*)::bigint
            FROM bot_touched b
            INNER JOIN outcomes o ON o.conversation_id = b.id
          ) AS converted_from_bot
      `
    : await prisma.$queryRaw<FunnelRow[]>`
        WITH cohort AS (
          SELECT DISTINCT c.id, c.handed_off_at
          FROM conversations c
          INNER JOIN messages m ON m.conversation_id = c.id
          WHERE m.sender = 'client' AND m.direction = 'in'
        ),
        bot_touched AS (
          SELECT DISTINCT c.id
          FROM cohort c
          INNER JOIN messages m ON m.conversation_id = c.id
          WHERE m.sender = 'bot' AND m.direction = 'out'
        ),
        outcomes AS (
          SELECT conversation_id, MIN(created_at) AS first_closed_at
          FROM (
            SELECT conversation_id, created_at
            FROM orders
            WHERE status IN ('submitted', 'confirmed')
              AND is_archived = false
            UNION ALL
            SELECT conversation_id, created_at
            FROM appointments
            WHERE status IN ('confirmed', 'synced')
          ) u
          GROUP BY conversation_id
        )
        SELECT
          (SELECT COUNT(*)::bigint FROM cohort) AS client_wrote,
          (SELECT COUNT(*)::bigint FROM bot_touched) AS bot_accepted,
          (
            SELECT COUNT(*)::bigint
            FROM cohort c
            INNER JOIN bot_touched b ON b.id = c.id
            INNER JOIN outcomes o ON o.conversation_id = c.id
            WHERE c.handed_off_at IS NULL
               OR o.first_closed_at < c.handed_off_at
          ) AS bot_closed,
          (
            SELECT COUNT(*)::bigint
            FROM cohort c
            WHERE c.handed_off_at IS NOT NULL
          ) AS handed_to_manager,
          (
            SELECT COUNT(*)::bigint
            FROM cohort c
            INNER JOIN outcomes o ON o.conversation_id = c.id
            WHERE c.handed_off_at IS NOT NULL
              AND o.first_closed_at >= c.handed_off_at
          ) AS handoff_then_closed,
          (
            SELECT COUNT(*)::bigint
            FROM bot_touched b
            INNER JOIN outcomes o ON o.conversation_id = b.id
          ) AS converted_from_bot
      `;

  return (
    rows[0] ?? {
      client_wrote: 0n,
      bot_accepted: 0n,
      bot_closed: 0n,
      handed_to_manager: 0n,
      handoff_then_closed: 0n,
      converted_from_bot: 0n,
    }
  );
}

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return part / whole;
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
      briefStats,
      qualityStats,
      claudeUsageSnapshot,
      funnelRow,
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
      prisma.crmSyncRun.findFirst({
        where: { status: 'ok' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, startedAt: true },
      }),
      prisma.conversation.count(),
      loadDailySeries(seriesFrom),
      loadBriefStats(from),
      loadQualityStats(from),
      loadClaudeUsageSnapshot(),
      loadConversationFunnel(from),
    ]);

    const ordersInPipeline = ordersSubmitted + ordersConfirmed;

    const series = dailyRows.map((r) => ({
      date: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
      botReplies: Number(r.bot_out),
      clientMessages: Number(r.client_in),
    }));

    const crmWrite = await isCrmWriteReady();

    const briefsTotal = Number(briefStats.total);
    const briefsHighCompleteness = Number(briefStats.high_completeness);

    const clientWrote = Number(funnelRow.client_wrote);
    const botAccepted = Number(funnelRow.bot_accepted);
    const botClosed = Number(funnelRow.bot_closed);
    const handedToManager = Number(funnelRow.handed_to_manager);
    const handoffThenClosed = Number(funnelRow.handoff_then_closed);
    const convertedFromBot = Number(funnelRow.converted_from_bot);

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
      funnel: {
        clientWrote,
        botAccepted,
        botClosed,
        handedToManager,
        handoffThenClosed,
        convertedFromBot,
        botAcceptRate: rate(botAccepted, clientWrote),
        botCloseRate: rate(botClosed, botAccepted),
        handoffRate: rate(handedToManager, botAccepted),
        handoffCloseRate: rate(handoffThenClosed, handedToManager),
        conversionFromBotRate: rate(convertedFromBot, botAccepted),
      },
      briefs: {
        total: briefsTotal,
        highCompleteness: briefsHighCompleteness,
        highCompletenessRate: briefsTotal > 0 ? briefsHighCompleteness / briefsTotal : null,
        avgCompletenessPct: briefStats.avg_completeness !== null
          ? Math.round(briefStats.avg_completeness)
          : null,
        avgConfidence: briefStats.avg_confidence !== null
          ? Number(briefStats.avg_confidence.toFixed(2))
          : null,
      },
      quality: {
        rated: Number(qualityStats.rated),
        avgQuality: qualityStats.avg_quality !== null
          ? Number(qualityStats.avg_quality.toFixed(2))
          : null,
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
        crmWriteReady: crmWrite.ready,
        crmWriteEnabled: crmWrite.enabled,
        crmWriteSource: crmWrite.source,
        crmWriteMessage: crmWrite.reason ?? null,
        claudeUsage: claudeUsageSnapshot
          ? {
              status: claudeUsageSnapshot.status,
              worstPercent: claudeUsageSnapshot.worstPercent,
              message: claudeUsageSnapshot.message,
              checkedAt: claudeUsageSnapshot.checkedAt,
              subscriptionType: claudeUsageSnapshot.subscriptionType,
              buckets: claudeUsageSnapshot.buckets,
            }
          : null,
      },
      series,
    };
  });
}
