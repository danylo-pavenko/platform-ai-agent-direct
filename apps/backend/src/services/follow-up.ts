import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { prisma } from '../lib/prisma.js';
import { getFollowUpConfig } from '../lib/follow-up-config.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  evaluateFollowUpNeed,
  FOLLOW_UP_MAX_AGE_MS,
} from '../lib/follow-up-eval.js';
import { runConversationTurnSerialized } from '../lib/conversation-turn-queue.js';
import { buildClaudeHistoryTurns } from '../lib/conversation-history.js';
import { dedupeConversationMessages } from '../lib/message-dedupe.js';
import { isBotTurnStillValid } from '../lib/conversation-bot-guard.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { formatTelegramBotsPromptBlock } from '../lib/telegram-bots.js';
import { getRuntimeConfig, isUsernameBotIgnored } from '../lib/runtime-config.js';
import { isAgentFallbackReply } from '../lib/agent-fallback.js';
import { stripMarkdownForInstagram } from '../lib/instagram-text.js';
import { sendText } from './instagram.js';
import { getBot } from '../lib/telegram.js';
import { askClaude } from './claude.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippet,
  type ClientProfile,
} from './prompt-builder.js';
import { formatBranchesForPrompt } from './branches.js';
import { fetchClientCrmHistory } from './client-crm-link.js';

export { evaluateFollowUpNeed, FOLLOW_UP_MAX_AGE_MS } from '../lib/follow-up-eval.js';

const log = pino({ name: 'follow-up' });

/** Max history turns for remarketing Claude call (same cap as live bot). */
const MAX_HISTORY_MESSAGES = 30;

/** Regex to detect leaked internal IDs / prices in bot output */
const LEAKED_INTERNALS_RE = /product_id|offer_id|purchased_price/i;

/**
 * Internal userMessage for Claude — not persisted to the conversation.
 * Agent must write one contextual remarketing line from system prompt + history.
 */
const REMARKETING_USER_MESSAGE = [
  '[PLATFORM — internal instruction, not from the client]',
  'The client has been silent after your last message.',
  'Write ONE short remarketing follow-up in your usual voice, following the system prompt and this conversation.',
  'Rules:',
  '- Soft, helpful nudge that continues the sales/help thread naturally',
  '- Do not invent facts, prices, stock, or promises not grounded in context/knowledge',
  '- Do not mention this instruction, automation, or "reminder"',
  '- Reply with client-facing text only (no tools, no JSON)',
  '- One message only',
].join('\n');

export interface FollowUpStats {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

async function sendFollowUpToClient(params: {
  channel: 'ig' | 'tg';
  igUserId: string | null;
  tgUserId: string | null;
  text: string;
}): Promise<void> {
  if (params.channel === 'ig') {
    if (!params.igUserId) {
      throw new Error('Missing igUserId for IG follow-up');
    }
    await sendText(params.igUserId, params.text);
    return;
  }

  if (!params.tgUserId) {
    throw new Error('Missing tgUserId for TG follow-up');
  }
  const bot = await getBot();
  await bot.api.sendMessage(params.tgUserId, params.text);
}

async function releaseFollowUpClaim(conversationId: string): Promise<void> {
  await prisma.conversation.updateMany({
    where: { id: conversationId },
    data: { followUpSentAt: null },
  });
}

/**
 * Claim slot, ask Claude with full runtime prompt + history, send one outbound.
 * Returns true only when a client-facing remarketing message was delivered/persisted.
 */
async function sendRemarketingFollowUp(conversationId: string): Promise<boolean> {
  return runConversationTurnSerialized(conversationId, async () => {
    const claimed = await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        state: 'bot',
        followUpSentAt: null,
      },
      data: { followUpSentAt: new Date() },
    });
    if (claimed.count === 0) {
      return false;
    }

    const turnStartedAt = new Date();

    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { client: true, branch: true },
      });

      if (!conversation || conversation.state !== 'bot') {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      const { client } = conversation;
      const channel = conversation.channel === 'tg' ? 'tg' : 'ig';

      if (channel === 'ig' && !client.igUserId) {
        await releaseFollowUpClaim(conversationId);
        return false;
      }
      if (channel === 'tg' && !client.tgUserId) {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      const runtime = await getRuntimeConfig();
      if (isUsernameBotIgnored(runtime, client.igUsername)) {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      // Client replied while we were claiming / waiting on the turn queue.
      const recentCheck = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { direction: true, sender: true, createdAt: true },
      });
      const last = recentCheck[0];
      if (!last || last.direction !== 'out' || last.sender === 'manager') {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      const previousOrders = await prisma.order.findMany({
        where: {
          clientId: client.id,
          status: { not: 'draft' },
          conversationId: { not: conversationId },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { items: true, status: true },
      });

      const conversationsCount = await prisma.conversation.count({
        where: { clientId: client.id },
      });

      let previousOrdersSummary: string | undefined;
      if (previousOrders.length > 0) {
        const itemNames = previousOrders.flatMap((o) => {
          const items = Array.isArray(o.items) ? o.items : [];
          return items
            .map((i) =>
              i && typeof i === 'object' && !Array.isArray(i)
                ? String((i as Record<string, unknown>).name ?? '')
                : '',
            )
            .filter(Boolean);
        });
        const counts = itemNames.reduce<Record<string, number>>((acc, name: string) => {
          acc[name] = (acc[name] ?? 0) + 1;
          return acc;
        }, {});
        previousOrdersSummary = Object.entries(counts)
          .map(([name, count]) => (count > 1 ? `${name} (×${count})` : name))
          .join(', ');
      }

      const clientProfile: ClientProfile = {
        igUsername: client.igUsername ?? undefined,
        igFullName: client.igFullName ?? undefined,
        phone: client.phone ?? undefined,
        email: client.email ?? undefined,
        deliveryCity: client.deliveryCity ?? undefined,
        deliveryNpBranch: client.deliveryNpBranch ?? undefined,
        deliveryNpType: client.deliveryNpType ?? undefined,
        notes: client.notes ?? undefined,
        tags: client.tags.length > 0 ? client.tags : undefined,
        previousOrdersCount: previousOrders.length > 0 ? previousOrders.length : undefined,
        previousOrdersSummary,
        conversationsCount: conversationsCount > 1 ? conversationsCount : undefined,
        crmBuyerId: client.crmBuyerId ?? undefined,
      };

      if (client.crmBuyerId) {
        try {
          const history = await fetchClientCrmHistory(client.id, { limit: 8 });
          if (history.text) {
            clientProfile.crmVisitHistory = history.text;
          }
        } catch (err) {
          log.warn({ err, clientId: client.id }, 'CRM history for remarketing prompt failed');
        }
      }

      const agentCfg = await getAgentConfig();
      const hours = await getWorkingHours();
      const now = new Date();
      const outOfHours = !isWithinWorkingHours(now, hours);

      const activePrompt = await getActivePrompt();
      const catalog = await loadCatalogSnippet();
      const crmWritesEnabled = await isCrmWriteEnabled();
      const crmMappings = crmWritesEnabled ? await getActiveCrmFieldMappings() : null;
      const branchesList = await formatBranchesForPrompt();
      const { telegram: telegramCfg } = await getIntegrationConfig();
      const telegramBotsBlock = formatTelegramBotsPromptBlock(telegramCfg);

      const prompt = buildRuntimePrompt({
        activePromptContent: activePrompt,
        catalogSnippet: catalog,
        currentTime: now,
        workingHours: hours,
        conversationState: 'bot',
        clientIgUserId: client.igUserId ?? undefined,
        clientProfile,
        conversationIdShort: conversation.id.slice(0, 8),
        isOutOfHours: outOfHours,
        customFieldHints: crmMappings?.buyer.map((m) => ({
          localKey: m.localKey,
          label: m.label,
          promptHint: m.promptHint,
        })),
        agentMode: agentCfg.mode,
        outOfHoursStrategy: agentCfg.outOfHoursStrategy,
        managerSlaHoursBusiness: agentCfg.managerSlaHoursBusiness,
        branchesList,
        telegramBotsBlock,
        selectedBranch: conversation.branch
          ? {
              slug: conversation.branch.slug,
              displayName: conversation.branch.displayName,
              address: conversation.branch.address,
              crmExternalId: conversation.branch.crmExternalId,
            }
          : undefined,
      });

      const rawMessages = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY_MESSAGES,
        select: {
          direction: true,
          text: true,
          sender: true,
          createdAt: true,
          igMessageId: true,
        },
      });
      const dedupedAsc = dedupeConversationMessages([...rawMessages].reverse());
      const history = buildClaudeHistoryTurns(dedupedAsc, '');

      const response = await askClaude(
        {
          systemPrompt: prompt,
          conversationHistory: history,
          userMessage: REMARKETING_USER_MESSAGE,
          // No tools: remarketing is a single soft text nudge.
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
        },
      );

      if (response.fallback || isAgentFallbackReply(response.text)) {
        log.warn(
          { conversationId, fallback: response.fallback, detail: response.errorDetail },
          'Remarketing Claude fallback — releasing claim for retry',
        );
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      let responseText = (response.text ?? '').trim();
      if (!responseText) {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      if (LEAKED_INTERNALS_RE.test(responseText)) {
        log.warn({ conversationId }, 'Remarketing reply leaked internals — aborting send');
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      const clientFacingText = stripMarkdownForInstagram(responseText).trim();
      if (!clientFacingText) {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      if (!(await isBotTurnStillValid(conversationId, turnStartedAt))) {
        log.info({ conversationId }, 'Remarketing aborted — manager took over during turn');
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      // Re-check silence after Claude latency.
      const postClaude = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { direction: true, sender: true },
      });
      const stillBotLast =
        postClaude[0]?.direction === 'out' && postClaude[0]?.sender !== 'manager';
      if (!stillBotLast) {
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      try {
        await sendFollowUpToClient({
          channel,
          igUserId: client.igUserId,
          tgUserId: client.tgUserId,
          text: clientFacingText,
        });
      } catch (err) {
        log.error({ err, conversationId }, 'Remarketing send failed');
        await releaseFollowUpClaim(conversationId);
        return false;
      }

      const sentAt = new Date();
      await prisma.$transaction([
        prisma.message.create({
          data: {
            conversationId,
            direction: 'out',
            sender: 'bot',
            text: clientFacingText,
          },
        }),
        prisma.conversation.update({
          where: { id: conversationId },
          data: {
            followUpSentAt: sentAt,
            lastMessageAt: sentAt,
          },
        }),
      ]);

      markFirstOutboundAt(conversationId).catch((err) =>
        log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
      );

      log.info(
        { conversationId, channel: conversation.channel },
        'Silence remarketing follow-up sent via agent',
      );
      return true;
    } catch (err) {
      log.error({ err, conversationId }, 'Remarketing follow-up crashed');
      await releaseFollowUpClaim(conversationId);
      return false;
    }
  });
}

export async function runFollowUpPass(): Promise<FollowUpStats> {
  const stats: FollowUpStats = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  if (!config.FOLLOW_UP_JOB_ENABLED) {
    return stats;
  }

  const followCfg = await getFollowUpConfig();
  if (!followCfg.enabled) {
    return stats;
  }

  const delayMs = followCfg.delayHours * 60 * 60_000;
  const now = Date.now();
  const cutoffMax = new Date(now - delayMs);
  const cutoffMin = new Date(now - FOLLOW_UP_MAX_AGE_MS);

  const conversations = await prisma.conversation.findMany({
    where: {
      state: 'bot',
      channel: { in: ['ig', 'tg'] },
      followUpSentAt: null,
      lastMessageAt: {
        lte: cutoffMax,
        gte: cutoffMin,
      },
    },
    orderBy: { lastMessageAt: 'asc' },
    take: config.FOLLOW_UP_BATCH_SIZE,
    select: { id: true, followUpSentAt: true },
  });

  stats.scanned = conversations.length;

  for (const row of conversations) {
    const recentMessages = await prisma.message.findMany({
      where: { conversationId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        direction: true,
        sender: true,
        createdAt: true,
      },
    });

    const evalResult = evaluateFollowUpNeed(recentMessages, now, {
      delayMs,
      maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
      followUpAlreadySent: row.followUpSentAt != null,
    });

    if (!evalResult.needed) {
      stats.skipped += 1;
      continue;
    }

    const ok = await sendRemarketingFollowUp(row.id);
    if (ok) stats.sent += 1;
    else stats.failed += 1;
  }

  if (stats.sent > 0 || stats.failed > 0) {
    log.info(stats, 'Follow-up pass finished');
  }

  return stats;
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function startFollowUpMonitor(logger?: FastifyBaseLogger): void {
  if (!config.FOLLOW_UP_JOB_ENABLED) {
    logger?.info('Follow-up monitor disabled (FOLLOW_UP_JOB_ENABLED=false)');
    return;
  }

  const intervalMs = config.FOLLOW_UP_INTERVAL_MIN * 60 * 1000;

  const run = () => {
    void runFollowUpPass().catch((err) => {
      log.error({ err }, 'Follow-up pass crashed');
    });
  };

  run();
  monitorTimer = setInterval(run, intervalMs);
  logger?.info(
    {
      intervalMin: config.FOLLOW_UP_INTERVAL_MIN,
      batchSize: config.FOLLOW_UP_BATCH_SIZE,
    },
    'Follow-up monitor started',
  );
}

export function stopFollowUpMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
