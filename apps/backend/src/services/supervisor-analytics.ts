/**
 * Compact analytics payload for Super Admin (supervisor token).
 * Reuses the same funnel / agent_invocations definitions as the tenant dashboard.
 */
import { prisma } from '../lib/prisma.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { getPlatformVersion } from '../lib/platform-version-runtime.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { loadClaudeUsageSnapshot } from './claude-usage-monitor.js';
import { config } from '../config.js';

const PERIODS = ['7d', '30d', '90d'] as const;
export type AnalyticsPeriod = (typeof PERIODS)[number];

export function parseAnalyticsPeriod(q: string | undefined): AnalyticsPeriod {
  const v = (q ?? '7d').toLowerCase();
  return PERIODS.includes(v as AnalyticsPeriod) ? (v as AnalyticsPeriod) : '7d';
}

function periodStart(period: AnalyticsPeriod): Date {
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000);
}

function n(v: bigint | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'bigint' ? Number(v) : Number(v);
}

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 1000;
}

type FunnelSql = {
  client_wrote: bigint;
  bot_accepted: bigint;
  bot_closed: bigint;
  handed_to_manager: bigint;
  handoff_then_closed: bigint;
  converted_from_bot: bigint;
};

type AgentSql = {
  total: bigint;
  successes: bigint;
  failures: bigint;
  busy: bigint;
  timeout: bigint;
  p50: number | null;
  p95: number | null;
};

type BriefSql = {
  total: bigint;
};

async function loadFunnel(from: Date): Promise<FunnelSql> {
  const rows = await prisma.$queryRaw<FunnelSql[]>`
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

async function loadAgentTotals(from: Date): Promise<AgentSql> {
  const rows = await prisma.$queryRaw<AgentSql[]>`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE success)::bigint AS successes,
      COUNT(*) FILTER (WHERE NOT success)::bigint AS failures,
      COUNT(*) FILTER (WHERE fallback_reason = 'busy')::bigint AS busy,
      COUNT(*) FILTER (WHERE fallback_reason = 'timeout')::bigint AS timeout,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE success) AS p95
    FROM agent_invocations
    WHERE started_at >= ${from}
      AND channel IN ('ig', 'tg')
  `;
  return (
    rows[0] ?? {
      total: 0n,
      successes: 0n,
      failures: 0n,
      busy: 0n,
      timeout: 0n,
      p50: null,
      p95: null,
    }
  );
}

export type SupervisorAnalytics = {
  generatedAt: string;
  period: AnalyticsPeriod;
  instance: { id: string; name: string };
  platformVersion: { name: string; code: number };
  agentMode: string;
  funnel: {
    clientWrote: number;
    botAccepted: number;
    botClosed: number;
    handedToManager: number;
    handoffThenClosed: number;
    convertedFromBot: number;
    briefsSubmitted: number;
    botAcceptRate: number | null;
    botCloseRate: number | null;
    handoffRate: number | null;
    conversionFromBotRate: number | null;
  };
  claude: {
    invocations: number;
    successes: number;
    failures: number;
    busy: number;
    timeout: number;
    successRate: number | null;
    dropRate: number | null;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    botFailureMessages: number;
    auth: {
      binaryOk: boolean;
      loggedIn: boolean;
      sessionExpired: boolean;
      email: string | null;
      error: string | null;
    };
    usage: {
      status: string | null;
      worstPercent: number | null;
      message: string | null;
      checkedAt: string | null;
    };
  };
  prompt: {
    activeVersion: number | null;
    activeCreatedAt: string | null;
    activeAuthor: string | null;
    activeChangeSummary: string | null;
    totalVersions: number;
    recent: Array<{
      version: number;
      isActive: boolean;
      createdAt: string;
      author: string | null;
      changeSummary: string | null;
    }>;
  };
  activity: {
    lastInboundAt: string | null;
    lastBotReplyAt: string | null;
    conversationsBot: number;
    conversationsHandoff: number;
  };
  adminUsage: {
    lastLoginAt: string | null;
    lastLoginUsername: string | null;
    lastLoginRole: string | null;
    lastLoginDisplayName: string | null;
    activeAdmins: number;
    daysSinceLogin: number | null;
  };
  alerts: string[];
};

export async function buildSupervisorAnalytics(
  period: AnalyticsPeriod = '7d',
): Promise<SupervisorAnalytics> {
  const from = periodStart(period);
  const platformVersion = getPlatformVersion();

  const [
    funnelRow,
    agentRow,
    briefRow,
    botFailures,
    activePrompt,
    recentPrompts,
    totalVersions,
    agentCfg,
    claudeAuth,
    usageSnap,
    lastInbound,
    lastBotReply,
    stateGroups,
    lastAdminLogin,
    activeAdmins,
  ] = await Promise.all([
    loadFunnel(from),
    loadAgentTotals(from),
    prisma.$queryRaw<BriefSql[]>`
      SELECT COUNT(*)::bigint AS total
      FROM presale_briefs
      WHERE status IN ('submitted', 'synced')
        AND created_at >= ${from}
    `.then((rows) => rows[0] ?? { total: 0n }),
    prisma.message.count({
      where: {
        createdAt: { gte: from },
        botFailureCode: { not: null },
      },
    }),
    prisma.systemPrompt.findFirst({
      where: { isActive: true },
      select: {
        version: true,
        createdAt: true,
        author: true,
        changeSummary: true,
      },
    }),
    prisma.systemPrompt.findMany({
      orderBy: { version: 'desc' },
      take: 8,
      select: {
        version: true,
        isActive: true,
        createdAt: true,
        author: true,
        changeSummary: true,
      },
    }),
    prisma.systemPrompt.count(),
    getAgentConfig().catch(() => null),
    getClaudeAuthStatus({ skipLiveCache: true }),
    loadClaudeUsageSnapshot().catch(() => null),
    prisma.message.findFirst({
      where: { direction: 'in', sender: 'client' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.message.findFirst({
      where: { sender: 'bot', direction: 'out' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.conversation.groupBy({
      by: ['state'],
      _count: { _all: true },
    }),
    prisma.adminUser.findFirst({
      where: { lastLoginAt: { not: null } },
      orderBy: { lastLoginAt: 'desc' },
      select: {
        username: true,
        role: true,
        displayName: true,
        lastLoginAt: true,
      },
    }),
    prisma.adminUser.count({ where: { isActive: true } }),
  ]);

  const clientWrote = n(funnelRow.client_wrote);
  const botAccepted = n(funnelRow.bot_accepted);
  const botClosed = n(funnelRow.bot_closed);
  const handedToManager = n(funnelRow.handed_to_manager);
  const handoffThenClosed = n(funnelRow.handoff_then_closed);
  const convertedFromBot = n(funnelRow.converted_from_bot);
  const briefsSubmitted = n(briefRow.total);

  const invocations = n(agentRow.total);
  const successes = n(agentRow.successes);
  const failures = n(agentRow.failures);
  const busy = n(agentRow.busy);
  const timeout = n(agentRow.timeout);
  const drops = busy + timeout;

  const byState: Record<string, number> = { bot: 0, handoff: 0, paused: 0, closed: 0 };
  for (const row of stateGroups) {
    byState[row.state] = row._count._all;
  }

  const alerts: string[] = [];
  if (!claudeAuth.binaryOk || !claudeAuth.loggedIn || claudeAuth.sessionExpired) {
    alerts.push('claude_auth');
  }
  if (usageSnap?.status && usageSnap.status !== 'ok') {
    alerts.push('claude_quota');
  }
  if (invocations >= 5 && drops / invocations >= 0.15) {
    alerts.push('high_claude_drop');
  }
  if (clientWrote >= 5 && botAccepted / clientWrote < 0.7) {
    alerts.push('low_accept_rate');
  }
  if (!activePrompt) {
    alerts.push('no_active_prompt');
  }
  if (botFailures >= 5) {
    alerts.push('bot_failures');
  }

  const lastLoginAt = lastAdminLogin?.lastLoginAt ?? null;
  const daysSinceLogin =
    lastLoginAt != null
      ? Math.floor((Date.now() - lastLoginAt.getTime()) / 86_400_000)
      : null;
  if (lastLoginAt == null) {
    alerts.push('admin_never_logged_in');
  } else if (daysSinceLogin != null && daysSinceLogin >= 14) {
    alerts.push('admin_inactive');
  }

  return {
    generatedAt: new Date().toISOString(),
    period,
    instance: { id: config.INSTANCE_ID, name: config.INSTANCE_NAME },
    platformVersion: { name: platformVersion.name, code: platformVersion.code },
    agentMode: agentCfg?.mode ?? 'general',
    funnel: {
      clientWrote,
      botAccepted,
      botClosed,
      handedToManager,
      handoffThenClosed,
      convertedFromBot,
      briefsSubmitted,
      botAcceptRate: rate(botAccepted, clientWrote),
      botCloseRate: rate(botClosed, botAccepted),
      handoffRate: rate(handedToManager, clientWrote),
      conversionFromBotRate: rate(convertedFromBot, botAccepted),
    },
    claude: {
      invocations,
      successes,
      failures,
      busy,
      timeout,
      successRate: rate(successes, invocations),
      dropRate: rate(drops, invocations),
      latencyP50Ms: agentRow.p50 != null ? Math.round(agentRow.p50) : null,
      latencyP95Ms: agentRow.p95 != null ? Math.round(agentRow.p95) : null,
      botFailureMessages: botFailures,
      auth: {
        binaryOk: claudeAuth.binaryOk,
        loggedIn: claudeAuth.loggedIn,
        sessionExpired: claudeAuth.sessionExpired,
        email: claudeAuth.email,
        error: claudeAuth.error,
      },
      usage: {
        status: usageSnap?.status ?? null,
        worstPercent: usageSnap?.worstPercent ?? null,
        message: usageSnap?.message ?? null,
        checkedAt: usageSnap?.checkedAt ?? null,
      },
    },
    prompt: {
      activeVersion: activePrompt?.version ?? null,
      activeCreatedAt: activePrompt?.createdAt?.toISOString() ?? null,
      activeAuthor: activePrompt?.author != null ? String(activePrompt.author) : null,
      activeChangeSummary: activePrompt?.changeSummary ?? null,
      totalVersions,
      recent: recentPrompts.map((p) => ({
        version: p.version,
        isActive: p.isActive,
        createdAt: p.createdAt.toISOString(),
        author: p.author != null ? String(p.author) : null,
        changeSummary: p.changeSummary,
      })),
    },
    activity: {
      lastInboundAt: lastInbound?.createdAt?.toISOString() ?? null,
      lastBotReplyAt: lastBotReply?.createdAt?.toISOString() ?? null,
      conversationsBot: byState.bot ?? 0,
      conversationsHandoff: byState.handoff ?? 0,
    },
    adminUsage: {
      lastLoginAt: lastLoginAt?.toISOString() ?? null,
      lastLoginUsername: lastAdminLogin?.username ?? null,
      lastLoginRole: lastAdminLogin?.role != null ? String(lastAdminLogin.role) : null,
      lastLoginDisplayName: lastAdminLogin?.displayName ?? null,
      activeAdmins,
      daysSinceLogin,
    },
    alerts,
  };
}
