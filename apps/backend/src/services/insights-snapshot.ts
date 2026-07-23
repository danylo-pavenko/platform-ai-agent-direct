import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { getCrmRouting } from '../lib/crm-routing.js';
import { isCrmWriteReady } from '../lib/crm-write.js';
import {
  getIntegrationConfig,
  type IntegrationConfig,
} from '../lib/integration-config.js';
import { getTenantKnowledgeDir } from '../lib/paths.js';
import { prisma } from '../lib/prisma.js';
import { getRuntimeConfig } from '../lib/runtime-config.js';
import { getClaudeAuthStatus } from './claude-auth.js';

export const INSIGHTS_PERIODS = ['7d', '30d', '90d', 'all'] as const;
export type InsightsPeriod = (typeof INSIGHTS_PERIODS)[number];

const DAY_MS = 86_400_000;
const SAMPLE_LIMIT = 15;
const SAMPLE_MESSAGE_LIMIT = 4;
const SAMPLE_TEXT_LIMIT = 220;
const KNOWLEDGE_TEXT_LIMIT = 2_500;
const BUSINESS_KNOWLEDGE_FILES = [
  ['brand', 'brand.txt'],
  ['contacts', 'contacts.txt'],
  ['delivery', 'delivery.txt'],
  ['faq', 'faq.txt'],
] as const;

export function parseInsightsPeriod(value: unknown): InsightsPeriod {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '7d';
  return INSIGHTS_PERIODS.includes(normalized as InsightsPeriod)
    ? (normalized as InsightsPeriod)
    : '7d';
}

/** Rolling window start, or `null` for all-time (no lower bound). */
export function insightsPeriodStart(period: InsightsPeriod, now = new Date()): Date | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(now.getTime() - days * DAY_MS);
}

export function insightsPeriodLabel(period: InsightsPeriod): string {
  if (period === 'all') return 'за весь час';
  if (period === '7d') return 'за останні 7 днів';
  if (period === '30d') return 'за останні 30 днів';
  return 'за останні 90 днів';
}

/**
 * Remove common contact details before conversation snippets are sent to Claude
 * or exposed through the snapshot endpoint.
 */
export function redactInsightText(text: string): string {
  return text
    .replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      '[email приховано]',
    )
    .replace(
      /(?<!\d)(?:\+?38[\s().-]*)?0\d{2}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}(?!\d)/g,
      '[телефон приховано]',
    )
    .replace(
      /(?<![\w\d])\+?\d[\d\s().-]{7,}\d(?![\w\d])/g,
      '[телефон приховано]',
    );
}

export function truncateInsightText(text: string, limit = SAMPLE_TEXT_LIMIT): string {
  const normalized = redactInsightText(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export interface SafeIntegrationSummary {
  instagramConfigured: boolean;
  instagramUsername: string | null;
  telegramBotsConfigured: number;
  keycrmConfigured: boolean;
  cleverboxConfigured: boolean;
  novaPoshtaConfigured: boolean;
  novaPoshtaSenderCity: string | null;
}

/** Build an explicit allowlist projection; no integration secret can cross this boundary. */
export function buildSafeIntegrationSummary(
  integrationConfig: IntegrationConfig,
): SafeIntegrationSummary {
  return {
    instagramConfigured: Boolean(
      integrationConfig.meta.pageAccessToken && integrationConfig.meta.igUserId,
    ),
    instagramUsername: integrationConfig.meta.igUsername || null,
    telegramBotsConfigured: integrationConfig.telegram.bots.filter(
      (bot) => bot.enabled && Boolean(bot.botToken.trim()),
    ).length,
    keycrmConfigured: Boolean(integrationConfig.keycrm.apiKey),
    cleverboxConfigured: Boolean(integrationConfig.cleverbox.apiToken),
    novaPoshtaConfigured: Boolean(integrationConfig.novaposhta.apiKey),
    novaPoshtaSenderCity: integrationConfig.novaposhta.senderCity || null,
  };
}

async function loadBusinessKnowledge(): Promise<Record<string, string>> {
  const knowledgeDir = resolve(getTenantKnowledgeDir(), 'knowledge');
  const entries = await Promise.all(
    BUSINESS_KNOWLEDGE_FILES.map(async ([key, filename]) => {
      try {
        const content = (await readFile(resolve(knowledgeDir, filename), 'utf8')).trim();
        if (!content) return null;
        return [
          key,
          content.length > KNOWLEDGE_TEXT_LIMIT
            ? `${content.slice(0, KNOWLEDGE_TEXT_LIMIT).trimEnd()}\n…`
            : content,
        ] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

type TtfrRow = {
  samples: bigint;
  p50: number | null;
  p95: number | null;
  avg: number | null;
};

type BriefRow = {
  total: bigint;
  high_completeness: bigint;
  synced: bigint;
  failed: bigint;
  avg_completeness: number | null;
};

type TagRow = {
  tag: string;
  count: bigint;
};

export interface InsightsSnapshot {
  generatedAt: string;
  period: InsightsPeriod;
  periodLabel: string;
  from: string | null;
  to: string;
  /** Always-present inventory of the whole tenant DB (independent of period). */
  totalsAllTime: {
    conversations: number;
    messages: number;
    inboundMessages: number;
    botReplies: number;
    managerReplies: number;
    clients: number;
  };
  messages: {
    total: number;
    inbound: number;
    outbound: number;
    botReplies: number;
    managerReplies: number;
    botFailures: number;
  };
  conversations: {
    /** Conversations with lastMessageAt inside the selected period (or all if period=all). */
    active: number;
    byState: Record<string, number>;
    byIntent: Array<{ intent: string; count: number }>;
    handoffRatePct: number | null;
    topHandoffReasons: Array<{ reason: string; count: number }>;
  };
  clients: {
    /** All clients in DB (all-time). */
    total: number;
    /** Distinct clients with a conversation active in the selected period. */
    active: number;
    new: number;
    repeat: number;
    withContactDetails: number;
    linkedToCrm: number;
    topTags: Array<{ tag: string; count: number }>;
  };
  orders: {
    created: number;
    submitted: number;
    confirmed: number;
    cancelled: number;
    crmSynced: number;
    crmFailed: number;
  };
  appointments: {
    created: number;
    confirmed: number;
    synced: number;
    failed: number;
    cancelled: number;
  };
  quality: {
    ratedConversations: number;
    averageBriefQuality: number | null;
    briefs: number;
    highCompletenessBriefs: number;
    briefsSyncedToCrm: number;
    briefsFailedToSync: number;
    averageCompletenessPct: number | null;
  };
  ttfr: {
    samples: number;
    p50Seconds: number | null;
    p95Seconds: number | null;
    averageSeconds: number | null;
  };
  claudeAuth: {
    loggedIn: boolean;
    sessionExpired: boolean;
    subscriptionType: string | null;
    error: string | null;
  };
  business: {
    instanceName: string;
    brandName: string;
    knowledge: Record<string, string>;
  };
  configuration: {
    agent: {
      mode: string;
      outOfHoursStrategy: string;
      managerSlaHoursBusiness: number;
      sessionFreshnessDays: number;
    };
    runtime: {
      mode: string;
      debugWhitelistCount: number;
      ignoredUsernamesCount: number;
    };
    workingHours: unknown;
    integrations: SafeIntegrationSummary;
    crmRouting: {
      mode: string;
      defaultProvider: string;
      enabledProviders: string[];
      routes: Record<string, string>;
    };
    branches: {
      active: number;
      names: string[];
    };
    crmFields: {
      active: number;
      labels: string[];
    };
  };
  crm: {
    writeReady: boolean;
    writeEnabled: boolean;
    writeSource: string;
    writeIssue: string | null;
    latestSync: {
      status: string;
      provider: string;
      syncType: string;
      startedAt: string;
      finishedAt: string | null;
      counts: unknown;
    } | null;
  };
  samples: Array<{
    id: string;
    path: string;
    channel: string;
    state: string;
    intent: string | null;
    clientName: string;
    lastMessageAt: string | null;
    messages: Array<{
      direction: string;
      sender: string;
      text: string;
      createdAt: string;
    }>;
  }>;
  /**
   * Most recent dialogues in the whole DB (ignores period).
   * Use when period samples are empty or the user asks about “усі діалоги”.
   */
  recentAll: Array<{
    id: string;
    path: string;
    channel: string;
    state: string;
    intent: string | null;
    clientName: string;
    lastMessageAt: string | null;
    messages: Array<{
      direction: string;
      sender: string;
      text: string;
      createdAt: string;
    }>;
  }>;
}

export async function buildInsightsSnapshot(
  period: InsightsPeriod,
): Promise<InsightsSnapshot> {
  const now = new Date();
  const from = insightsPeriodStart(period, now);
  const conversationWindow = from ? { lastMessageAt: { gte: from } } : {};
  const messageWindow = from ? { createdAt: { gte: from } } : {};
  const clientActivityWindow = from ? { lastActivityAt: { gte: from } } : {};
  const clientCreatedWindow = from ? { createdAt: { gte: from } } : {};

  const conversationSampleSelect = {
    id: true,
    channel: true,
    state: true,
    intent: true,
    lastMessageAt: true,
    client: {
      select: {
        displayName: true,
        igUsername: true,
        igFullName: true,
      },
    },
    messages: {
      where: { text: { not: null } },
      orderBy: { createdAt: 'desc' as const },
      take: SAMPLE_MESSAGE_LIMIT,
      select: {
        direction: true,
        sender: true,
        text: true,
        createdAt: true,
      },
    },
  };

  const [
    messageGroups,
    stateGroups,
    intentGroups,
    activeConversations,
    activeClientGroups,
    handoffConversations,
    handoffReasonGroups,
    orderGroups,
    orderCrmGroups,
    appointmentGroups,
    qualityStats,
    briefRows,
    ttfrRows,
    tagRows,
    totalClients,
    newClients,
    clientsWithContactDetails,
    clientsLinkedToCrm,
    botFailures,
    sampleRows,
    recentAllRows,
    allTimeConversations,
    allTimeMessageGroups,
    claudeAuth,
    agentConfig,
    runtimeConfig,
    integrationConfig,
    crmRouting,
    crmWrite,
    workingHoursRow,
    latestSync,
    activeBranches,
    activeCrmFields,
    businessKnowledge,
  ] = await Promise.all([
    prisma.message.groupBy({
      by: ['direction', 'sender'],
      where: messageWindow,
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ['state'],
      where: conversationWindow,
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ['intent'],
      where: conversationWindow,
      _count: { _all: true },
    }),
    prisma.conversation.count({ where: conversationWindow }),
    prisma.conversation.groupBy({
      by: ['clientId'],
      where: conversationWindow,
      _count: { _all: true },
    }),
    prisma.conversation.count({
      where: { ...conversationWindow, state: 'handoff' },
    }),
    prisma.conversation.groupBy({
      by: ['handoffReason'],
      where: {
        ...conversationWindow,
        state: 'handoff',
        handoffReason: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['status'],
      where: { ...(from ? { createdAt: { gte: from } } : {}), isArchived: false },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['crmSyncStatus'],
      where: { ...(from ? { createdAt: { gte: from } } : {}), isArchived: false },
      _count: { _all: true },
    }),
    prisma.appointment.groupBy({
      by: ['status'],
      where: from ? { createdAt: { gte: from } } : {},
      _count: { _all: true },
    }),
    prisma.conversation.aggregate({
      where: { ...conversationWindow, briefQuality: { not: null } },
      _count: { briefQuality: true },
      _avg: { briefQuality: true },
    }),
    from
      ? prisma.$queryRaw<BriefRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('submitted', 'synced'))::bigint AS total,
        COUNT(*) FILTER (
          WHERE status IN ('submitted', 'synced') AND completeness_pct >= 80
        )::bigint AS high_completeness,
        COUNT(*) FILTER (WHERE status = 'synced')::bigint AS synced,
        COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
        AVG(completeness_pct) FILTER (
          WHERE status IN ('submitted', 'synced')
        )::float8 AS avg_completeness
      FROM presale_briefs
      WHERE created_at >= ${from}
    `
      : prisma.$queryRaw<BriefRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('submitted', 'synced'))::bigint AS total,
        COUNT(*) FILTER (
          WHERE status IN ('submitted', 'synced') AND completeness_pct >= 80
        )::bigint AS high_completeness,
        COUNT(*) FILTER (WHERE status = 'synced')::bigint AS synced,
        COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
        AVG(completeness_pct) FILTER (
          WHERE status IN ('submitted', 'synced')
        )::float8 AS avg_completeness
      FROM presale_briefs
    `,
    from
      ? prisma.$queryRaw<TtfrRow[]>`
      SELECT
        COUNT(*)::bigint AS samples,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))
        ) AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))
        ) AS p95,
        AVG(EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at)))::float8 AS avg
      FROM conversations
      WHERE first_inbound_at IS NOT NULL
        AND first_outbound_at IS NOT NULL
        AND first_outbound_at > first_inbound_at
        AND first_inbound_at >= ${from}
    `
      : prisma.$queryRaw<TtfrRow[]>`
      SELECT
        COUNT(*)::bigint AS samples,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))
        ) AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at))
        ) AS p95,
        AVG(EXTRACT(EPOCH FROM (first_outbound_at - first_inbound_at)))::float8 AS avg
      FROM conversations
      WHERE first_inbound_at IS NOT NULL
        AND first_outbound_at IS NOT NULL
        AND first_outbound_at > first_inbound_at
    `,
    from
      ? prisma.$queryRaw<TagRow[]>`
      SELECT tag, COUNT(*)::bigint AS count
      FROM clients, LATERAL unnest(tags) AS tag
      WHERE last_activity_at >= ${from}
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT 10
    `
      : prisma.$queryRaw<TagRow[]>`
      SELECT tag, COUNT(*)::bigint AS count
      FROM clients, LATERAL unnest(tags) AS tag
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT 10
    `,
    prisma.client.count(),
    prisma.client.count({ where: clientCreatedWindow }),
    prisma.client.count({
      where: {
        ...clientActivityWindow,
        OR: [{ phone: { not: null } }, { email: { not: null } }],
      },
    }),
    prisma.client.count({
      where: {
        ...clientActivityWindow,
        crmBuyerId: { not: null },
      },
    }),
    prisma.message.count({
      where: {
        ...messageWindow,
        botFailureCode: { not: null },
      },
    }),
    prisma.conversation.findMany({
      where: conversationWindow,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: SAMPLE_LIMIT,
      select: conversationSampleSelect,
    }),
    prisma.conversation.findMany({
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: SAMPLE_LIMIT,
      select: conversationSampleSelect,
    }),
    prisma.conversation.count(),
    prisma.message.groupBy({
      by: ['direction', 'sender'],
      _count: { _all: true },
    }),
    getClaudeAuthStatus(),
    getAgentConfig(),
    getRuntimeConfig(),
    getIntegrationConfig(),
    getCrmRouting(),
    isCrmWriteReady(),
    prisma.setting.findUnique({
      where: { key: 'working_hours' },
      select: { value: true },
    }),
    prisma.crmSyncRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: {
        status: true,
        provider: true,
        syncType: true,
        startedAt: true,
        finishedAt: true,
        counts: true,
      },
    }),
    prisma.branch.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      select: { displayName: true },
    }),
    prisma.crmFieldMapping.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
      select: { label: true },
    }),
    loadBusinessKnowledge(),
  ]);

  const messageCount = (direction?: string, sender?: string): number =>
    messageGroups
      .filter(
        (row) =>
          (!direction || row.direction === direction) &&
          (!sender || row.sender === sender),
      )
      .reduce((sum, row) => sum + row._count._all, 0);

  const allTimeMessageCount = (direction?: string, sender?: string): number =>
    allTimeMessageGroups
      .filter(
        (row) =>
          (!direction || row.direction === direction) &&
          (!sender || row.sender === sender),
      )
      .reduce((sum, row) => sum + row._count._all, 0);

  const mapConversationSample = (
    conversation: (typeof sampleRows)[number],
  ) => ({
    id: conversation.id,
    path: `/conversations/${conversation.id}`,
    channel: conversation.channel,
    state: conversation.state,
    intent: conversation.intent,
    clientName:
      conversation.client.displayName ??
      conversation.client.igFullName ??
      (conversation.client.igUsername
        ? `@${conversation.client.igUsername}`
        : 'Клієнт'),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    messages: [...conversation.messages].reverse().flatMap((message) => {
      if (!message.text?.trim()) return [];
      return [{
        direction: message.direction,
        sender: message.sender,
        text: truncateInsightText(message.text),
        createdAt: message.createdAt.toISOString(),
      }];
    }),
  });

  const byState: Record<string, number> = {
    bot: 0,
    handoff: 0,
    paused: 0,
    closed: 0,
  };
  for (const row of stateGroups) byState[row.state] = row._count._all;

  const byOrderStatus = Object.fromEntries(
    orderGroups.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;
  const byOrderCrmStatus = Object.fromEntries(
    orderCrmGroups.map((row) => [row.crmSyncStatus, row._count._all]),
  ) as Record<string, number>;
  const byAppointmentStatus = Object.fromEntries(
    appointmentGroups.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;
  const brief = briefRows[0] ?? {
    total: 0n,
    high_completeness: 0n,
    synced: 0n,
    failed: 0n,
    avg_completeness: null,
  };
  const ttfr = ttfrRows[0] ?? {
    samples: 0n,
    p50: null,
    p95: null,
    avg: null,
  };
  const safeIntegrations = buildSafeIntegrationSummary(integrationConfig);
  const crmRoutes: Record<string, string> = {};
  for (const [action, provider] of Object.entries(crmRouting.routes)) {
    if (provider) crmRoutes[action] = provider;
  }

  return {
    generatedAt: now.toISOString(),
    period,
    periodLabel: insightsPeriodLabel(period),
    from: from?.toISOString() ?? null,
    to: now.toISOString(),
    totalsAllTime: {
      conversations: allTimeConversations,
      messages: allTimeMessageCount(),
      inboundMessages: allTimeMessageCount('in'),
      botReplies: allTimeMessageCount(undefined, 'bot'),
      managerReplies: allTimeMessageCount(undefined, 'manager'),
      clients: totalClients,
    },
    messages: {
      total: messageCount(),
      inbound: messageCount('in'),
      outbound: messageCount('out'),
      botReplies: messageCount(undefined, 'bot'),
      managerReplies: messageCount(undefined, 'manager'),
      botFailures,
    },
    conversations: {
      active: activeConversations,
      byState,
      byIntent: intentGroups
        .map((row) => ({
          intent: row.intent ?? 'unclassified',
          count: row._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      handoffRatePct:
        activeConversations > 0
          ? Math.round((handoffConversations / activeConversations) * 1000) / 10
          : null,
      topHandoffReasons: handoffReasonGroups
        .map((row) => ({
          reason: truncateInsightText(row.handoffReason ?? 'Не вказано', 120),
          count: row._count._all,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    },
    clients: {
      total: totalClients,
      active: activeClientGroups.length,
      new: newClients,
      repeat: activeClientGroups.filter((row) => row._count._all > 1).length,
      withContactDetails: clientsWithContactDetails,
      linkedToCrm: clientsLinkedToCrm,
      topTags: tagRows.map((row) => ({
        tag: row.tag,
        count: Number(row.count),
      })),
    },
    orders: {
      created: orderGroups.reduce((sum, row) => sum + row._count._all, 0),
      submitted: byOrderStatus.submitted ?? 0,
      confirmed: byOrderStatus.confirmed ?? 0,
      cancelled: byOrderStatus.cancelled ?? 0,
      crmSynced: byOrderCrmStatus.synced ?? 0,
      crmFailed: byOrderCrmStatus.failed ?? 0,
    },
    appointments: {
      created: appointmentGroups.reduce((sum, row) => sum + row._count._all, 0),
      confirmed: byAppointmentStatus.confirmed ?? 0,
      synced: byAppointmentStatus.synced ?? 0,
      failed: byAppointmentStatus.failed ?? 0,
      cancelled: byAppointmentStatus.cancelled ?? 0,
    },
    quality: {
      ratedConversations: qualityStats._count.briefQuality,
      averageBriefQuality:
        qualityStats._avg.briefQuality !== null
          ? Math.round(qualityStats._avg.briefQuality * 10) / 10
          : null,
      briefs: Number(brief.total),
      highCompletenessBriefs: Number(brief.high_completeness),
      briefsSyncedToCrm: Number(brief.synced),
      briefsFailedToSync: Number(brief.failed),
      averageCompletenessPct:
        brief.avg_completeness !== null
          ? Math.round(brief.avg_completeness)
          : null,
    },
    ttfr: {
      samples: Number(ttfr.samples),
      p50Seconds: ttfr.p50 !== null ? Math.round(ttfr.p50) : null,
      p95Seconds: ttfr.p95 !== null ? Math.round(ttfr.p95) : null,
      averageSeconds: ttfr.avg !== null ? Math.round(ttfr.avg) : null,
    },
    claudeAuth: {
      loggedIn: claudeAuth.loggedIn,
      sessionExpired: claudeAuth.sessionExpired,
      subscriptionType: claudeAuth.subscriptionType,
      error: claudeAuth.error,
    },
    business: {
      instanceName: config.INSTANCE_NAME,
      brandName: config.BRAND_NAME,
      knowledge: businessKnowledge,
    },
    configuration: {
      agent: {
        mode: agentConfig.mode,
        outOfHoursStrategy: agentConfig.outOfHoursStrategy,
        managerSlaHoursBusiness: agentConfig.managerSlaHoursBusiness,
        sessionFreshnessDays: agentConfig.sessionFreshnessDays,
      },
      runtime: {
        mode: runtimeConfig.mode,
        debugWhitelistCount: runtimeConfig.debugWhitelist.length,
        ignoredUsernamesCount: runtimeConfig.botIgnoreUsernames.length,
      },
      workingHours: workingHoursRow?.value ?? null,
      integrations: safeIntegrations,
      crmRouting: {
        mode: crmRouting.mode,
        defaultProvider: crmRouting.default,
        enabledProviders: crmRouting.enabled_providers,
        routes: crmRoutes,
      },
      branches: {
        active: activeBranches.length,
        names: activeBranches.map((branch) => branch.displayName),
      },
      crmFields: {
        active: activeCrmFields.length,
        labels: activeCrmFields.map((field) => field.label),
      },
    },
    crm: {
      writeReady: crmWrite.ready,
      writeEnabled: crmWrite.enabled,
      writeSource: crmWrite.source,
      writeIssue: crmWrite.reason ?? null,
      latestSync: latestSync
        ? {
            status: latestSync.status,
            provider: latestSync.provider,
            syncType: latestSync.syncType,
            startedAt: latestSync.startedAt.toISOString(),
            finishedAt: latestSync.finishedAt?.toISOString() ?? null,
            counts: latestSync.counts,
          }
        : null,
    },
    samples: sampleRows.map(mapConversationSample),
    recentAll: recentAllRows.map(mapConversationSample),
  };
}
