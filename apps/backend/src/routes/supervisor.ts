/**
 * supervisor.ts
 *
 * Private endpoint used exclusively by the super-admin dashboard to
 * chat with "Supervisor Claude" — a diagnostic assistant that answers
 * questions about this tenant (usage, dialog activity, handoff rate,
 * whether the bot is actively replying, etc.).
 *
 * Claude is invoked via the shared askClaude() helper, which means it
 * runs under the Linux user this backend process was started as (PM2
 * spawns the tenant backend as `tenant.linuxUser`), so the `claude`
 * CLI uses that user's own auth — matching the isolation the user
 * described ("Claude authorized under the client's Linux user").
 *
 * Security model:
 *   - Protected by a shared secret passed as the `X-Supervisor-Token`
 *     header. If SUPERVISOR_SHARED_SECRET is unset, the endpoint is
 *     disabled (returns 503).
 *   - The secret lives only in the tenant .env and in the super-admin
 *     .env — never reaches the browser.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { askClaude, claudeHealthCheck } from '../services/claude.js';
import { config } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface DiagnosticSnapshot {
  generatedAt: string;
  instance: { id: string; name: string };
  conversations: {
    total: number;
    byState: Record<string, number>;
    createdLast7d: number;
    createdLast30d: number;
    staleBotOver24h: number;
  };
  messages: {
    totalLast24h: number;
    totalLast7d: number;
    totalLast30d: number;
    inboundLast7d: number;
    botRepliesLast7d: number;
    managerRepliesLast7d: number;
  };
  clients: {
    total: number;
    activeLast7d: number;
    activeLast30d: number;
  };
  orders: {
    total: number;
    submittedLast7d: number;
    draftCount: number;
  };
  latestActivity: {
    lastInboundAt: string | null;
    lastBotReplyAt: string | null;
    lastManagerReplyAt: string | null;
  };
  botHealth: {
    activePromptVersion: number | null;
    handoffRatePct: number | null;
  };
}

// ── Diagnostic snapshot ──────────────────────────────────────────────────────

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

async function buildDiagnosticSnapshot(): Promise<DiagnosticSnapshot> {
  const now = new Date();
  const t24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const t7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const t30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalConversations,
    stateGroups,
    convosCreated7d,
    convosCreated30d,
    staleBotOver24h,
    messagesLast24h,
    messagesLast7d,
    messagesLast30d,
    inboundLast7d,
    botRepliesLast7d,
    managerRepliesLast7d,
    totalClients,
    activeClients7dGroups,
    activeClients30dGroups,
    totalOrders,
    submittedOrders7d,
    draftOrders,
    lastInbound,
    lastBotReply,
    lastManagerReply,
    activePrompt,
    handoffConvos,
  ] = await Promise.all([
    prisma.conversation.count(),
    prisma.conversation.groupBy({
      by: ['state'],
      _count: { _all: true },
    }),
    prisma.conversation.count({ where: { createdAt: { gte: t7d } } }),
    prisma.conversation.count({ where: { createdAt: { gte: t30d } } }),
    prisma.conversation.count({
      where: {
        state: 'bot',
        OR: [
          { lastMessageAt: { lt: t24h } },
          { lastMessageAt: null, createdAt: { lt: t24h } },
        ],
      },
    }),
    prisma.message.count({ where: { createdAt: { gte: t24h } } }),
    prisma.message.count({ where: { createdAt: { gte: t7d } } }),
    prisma.message.count({ where: { createdAt: { gte: t30d } } }),
    prisma.message.count({
      where: { createdAt: { gte: t7d }, direction: 'in' },
    }),
    prisma.message.count({
      where: { createdAt: { gte: t7d }, sender: 'bot' },
    }),
    prisma.message.count({
      where: { createdAt: { gte: t7d }, sender: 'manager' },
    }),
    prisma.client.count(),
    prisma.message.groupBy({
      by: ['conversationId'],
      where: { createdAt: { gte: t7d }, sender: 'client' },
    }),
    prisma.message.groupBy({
      by: ['conversationId'],
      where: { createdAt: { gte: t30d }, sender: 'client' },
    }),
    prisma.order.count(),
    prisma.order.count({
      where: { submittedToManagerAt: { gte: t7d } },
    }),
    prisma.order.count({ where: { status: 'draft' } }),
    prisma.message.findFirst({
      where: { direction: 'in' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.message.findFirst({
      where: { sender: 'bot' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.message.findFirst({
      where: { sender: 'manager' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.systemPrompt.findFirst({
      where: { isActive: true },
      select: { version: true },
    }),
    prisma.conversation.count({
      where: { state: 'handoff', createdAt: { gte: t30d } },
    }),
  ]);

  const byState: Record<string, number> = {
    bot: 0,
    handoff: 0,
    paused: 0,
    closed: 0,
  };
  for (const row of stateGroups) {
    byState[row.state] = row._count._all;
  }

  const handoffRatePct =
    convosCreated30d > 0
      ? Math.round((handoffConvos / convosCreated30d) * 1000) / 10
      : null;

  // `groupBy` over conversationId returns one row per conversation touched —
  // which is a reasonable proxy for "active clients" because each conversation
  // belongs to exactly one client. True unique-client count would require
  // joining through Conversation; this is close enough for the summary.
  return {
    generatedAt: now.toISOString(),
    instance: { id: config.INSTANCE_ID, name: config.INSTANCE_NAME },
    conversations: {
      total: totalConversations,
      byState,
      createdLast7d: convosCreated7d,
      createdLast30d: convosCreated30d,
      staleBotOver24h,
    },
    messages: {
      totalLast24h: messagesLast24h,
      totalLast7d: messagesLast7d,
      totalLast30d: messagesLast30d,
      inboundLast7d,
      botRepliesLast7d,
      managerRepliesLast7d,
    },
    clients: {
      total: totalClients,
      activeLast7d: activeClients7dGroups.length,
      activeLast30d: activeClients30dGroups.length,
    },
    orders: {
      total: totalOrders,
      submittedLast7d: submittedOrders7d,
      draftCount: draftOrders,
    },
    latestActivity: {
      lastInboundAt: isoOrNull(lastInbound?.createdAt),
      lastBotReplyAt: isoOrNull(lastBotReply?.createdAt),
      lastManagerReplyAt: isoOrNull(lastManagerReply?.createdAt),
    },
    botHealth: {
      activePromptVersion: activePrompt?.version ?? null,
      handoffRatePct,
    },
  };
}

// ── System prompt ────────────────────────────────────────────────────────────

function buildSupervisorSystemPrompt(snapshot: DiagnosticSnapshot): string {
  return [
    'Ти — супервайзор-асистент для супер-адміна платформи AI Sales Agent.',
    `Цей інстанс: ${snapshot.instance.name} (${snapshot.instance.id}).`,
    '',
    'Твоя роль: відповідати на питання про стан саме цього інстансу —',
    'чи використовується агент, чи є активність у діалогах, чи бот відповідає,',
    'чи часто втручається менеджер, тощо. Спілкування — українською мовою.',
    '',
    'Відповідай лаконічно: 2-6 речень. Наводь конкретні числа зі зведення нижче,',
    'позначай тривожні сигнали (довго немає активності, високий handoff-rate,',
    'застарілі діалоги в стані bot). Якщо даних недостатньо — прямо скажи.',
    'НЕ вигадуй метрик, яких немає у snapshot. НЕ копіюй весь блок дослівно —',
    'інтерпретуй та узагальнюй.',
    '',
    '<snapshot>',
    JSON.stringify(snapshot, null, 2),
    '</snapshot>',
    '',
    'Усі часові мітки — UTC, у форматі ISO 8601. "Last7d" = останні 7 діб.',
  ].join('\n');
}

// ── Routes ───────────────────────────────────────────────────────────────────

function requireSupervisorToken(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (!config.SUPERVISOR_SHARED_SECRET) {
    reply
      .code(503)
      .send({ error: 'Supervisor endpoint is disabled (no shared secret configured)' });
    return false;
  }

  const provided = request.headers['x-supervisor-token'];
  const token = Array.isArray(provided) ? provided[0] : provided;

  if (!token || token !== config.SUPERVISOR_SHARED_SECRET) {
    reply.code(401).send({ error: 'Invalid supervisor token' });
    return false;
  }

  return true;
}

export async function supervisorRoutes(app: FastifyInstance): Promise<void> {
  // GET /snapshot — raw diagnostic data (useful for debugging / future dashboards)
  app.get('/snapshot', async (request, reply) => {
    if (!requireSupervisorToken(request, reply)) return;
    return buildDiagnosticSnapshot();
  });

  // GET /claude-health — probes the Claude CLI binary the runtime spawn
  // actually uses. Returns { ok, path, version, error } so super-admin
  // can catch "auth expired" / "binary missing" instead of relying on
  // the silent fallback in askClaude.
  app.get('/claude-health', async (request, reply) => {
    if (!requireSupervisorToken(request, reply)) return;
    return claudeHealthCheck();
  });

  // POST /chat — ask Supervisor Claude a natural-language question
  app.post<{ Body: ChatBody }>('/chat', async (request, reply) => {
    if (!requireSupervisorToken(request, reply)) return;

    const { messages } = request.body ?? { messages: [] };

    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages array is required' });
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || !lastMessage.content?.trim()) {
      return reply.code(400).send({ error: 'last message must be a non-empty user message' });
    }

    const snapshot = await buildDiagnosticSnapshot();
    const systemPrompt = buildSupervisorSystemPrompt(snapshot);

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const response = await askClaude(
      {
        systemPrompt,
        conversationHistory: history,
        userMessage: lastMessage.content,
      },
      { channel: 'supervisor' },
    );

    return { reply: response.text, snapshotAt: snapshot.generatedAt };
  });
}
