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
  IG_MESSAGING_WINDOW_MS,
  isIgOutsideMessagingWindowError,
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
import { gateCustomerFacingReply } from '../lib/assistant-output.js';
import { sendText } from './instagram.js';
import { getBot } from '../lib/telegram.js';
import { askClaude } from './claude.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippet,
  loadKnowledgePack,
  type ClientProfile,
} from './prompt-builder.js';
import { formatBranchesForPrompt } from './branches.js';
import { fetchClientCrmHistory } from './client-crm-link.js';

export {
  evaluateFollowUpNeed,
  FOLLOW_UP_MAX_AGE_MS,
  IG_MESSAGING_WINDOW_MS,
  isIgOutsideMessagingWindowError,
} from '../lib/follow-up-eval.js';

export {
  scheduleFollowUpAfterBotOutbound,
  scheduleFollowUpAfterBotOutboundSafe,
  cancelPendingFollowUps,
  cancelPendingFollowUpsSafe,
  reschedulePendingFollowUpsForDelay,
  onFollowUpConfigSaved,
} from '../lib/follow-up-schedule.js';

const log = pino({ name: 'follow-up' });

/** Max history turns for remarketing Claude call (same cap as live bot). */
const MAX_HISTORY_MESSAGES = 30;

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
  consumed: number;
}

async function markJob(
  jobId: string,
  status: 'done' | 'cancelled' | 'failed',
  lastError?: string | null,
): Promise<void> {
  await prisma.followUpJob.update({
    where: { id: jobId },
    data: {
      status,
      lastError: lastError ? lastError.slice(0, 500) : null,
    },
  });
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

/**
 * Execute one due follow-up job. Claude only after cheap gates pass.
 * Does not schedule a new job after send (one nudge per silence cycle).
 */
async function processFollowUpJob(jobId: string, conversationId: string): Promise<'sent' | 'skipped' | 'failed'> {
  return runConversationTurnSerialized(conversationId, async () => {
    const turnStartedAt = new Date();

    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { client: true, branch: true },
      });

      if (!conversation || conversation.state !== 'bot') {
        await markJob(jobId, 'cancelled', 'conversation_not_bot');
        return 'skipped';
      }

      if (conversation.followUpSentAt) {
        await markJob(jobId, 'cancelled', 'already_sent_this_cycle');
        return 'skipped';
      }

      const { client } = conversation;
      const channel = conversation.channel === 'tg' ? 'tg' : 'ig';

      if (channel === 'ig' && !client.igUserId) {
        await markJob(jobId, 'failed', 'missing_ig_user_id');
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { followUpSentAt: new Date() },
        });
        return 'failed';
      }
      if (channel === 'tg' && !client.tgUserId) {
        await markJob(jobId, 'failed', 'missing_tg_user_id');
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { followUpSentAt: new Date() },
        });
        return 'failed';
      }

      const runtime = await getRuntimeConfig();
      if (isUsernameBotIgnored(runtime, client.igUsername)) {
        await markJob(jobId, 'cancelled', 'bot_ignored_username');
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { followUpSentAt: new Date() },
        });
        return 'skipped';
      }

      const recentCheck = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { direction: true, sender: true, createdAt: true },
      });

      const followCfg = await getFollowUpConfig();
      const delayMs = followCfg.delayHours * 60 * 60_000;
      const lastInbound = recentCheck.find(
        (m) => m.direction === 'in' && m.sender === 'client',
      );
      const gate = evaluateFollowUpNeed(recentCheck, Date.now(), {
        delayMs,
        maxAgeMs: FOLLOW_UP_MAX_AGE_MS,
        followUpAlreadySent: false,
        channel,
        lastClientInboundAt: lastInbound?.createdAt ?? null,
      });

      if (!gate.needed) {
        if (gate.reason === 'too_soon' && gate.lastBotAt) {
          await prisma.followUpJob.update({
            where: { id: jobId },
            data: {
              status: 'pending',
              runAt: new Date(gate.lastBotAt.getTime() + delayMs),
              lastError: 'too_soon_rescheduled',
            },
          });
          return 'skipped';
        }
        const permanent =
          gate.consumeWithoutSend ||
          gate.reason === 'outside_messaging_window' ||
          gate.reason === 'delay_exceeds_window' ||
          gate.reason === 'too_old';
        if (
          gate.reason === 'client_replied' ||
          gate.reason === 'manager_replied' ||
          gate.reason === 'no_bot_outbound'
        ) {
          await markJob(jobId, 'cancelled', gate.reason);
          return 'skipped';
        }
        await markJob(jobId, permanent ? 'failed' : 'cancelled', gate.reason);
        if (permanent) {
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { followUpSentAt: new Date() },
          });
        }
        log.info(
          { conversationId, jobId, reason: gate.reason },
          'Follow-up job skipped before Claude',
        );
        return permanent ? 'failed' : 'skipped';
      }

      // Claim silence slot so we never double-send / re-queue this cycle.
      const claimed = await prisma.conversation.updateMany({
        where: {
          id: conversationId,
          state: 'bot',
          followUpSentAt: null,
        },
        data: { followUpSentAt: new Date() },
      });
      if (claimed.count === 0) {
        await markJob(jobId, 'cancelled', 'claim_lost');
        return 'skipped';
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
      const knowledgePack = await loadKnowledgePack();
      const crmWritesEnabled = await isCrmWriteEnabled();
      const crmMappings = crmWritesEnabled ? await getActiveCrmFieldMappings() : null;
      const branchesList = await formatBranchesForPrompt();
      const { telegram: telegramCfg } = await getIntegrationConfig();
      const telegramBotsBlock = formatTelegramBotsPromptBlock(telegramCfg);

      const prompt = buildRuntimePrompt({
        activePromptContent: activePrompt,
        catalogSnippet: catalog,
        knowledgePack,
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
        },
        {
          channel: conversation.channel,
          conversationId,
          clientId: client.id,
        },
      );

      if (response.fallback || isAgentFallbackReply(response.text)) {
        await markJob(
          jobId,
          'failed',
          response.errorDetail ?? response.fallback ?? 'claude_fallback',
        );
        log.warn(
          { conversationId, jobId, fallback: response.fallback },
          'Remarketing Claude fallback — job failed (no retry)',
        );
        return 'failed';
      }

      const responseText = (response.text ?? '').trim();
      if (!responseText) {
        await markJob(jobId, 'failed', 'empty_output');
        return 'failed';
      }

      const gated = gateCustomerFacingReply(responseText);
      if (gated.rejected) {
        await markJob(jobId, 'failed', `output_gate:${gated.reason}`);
        log.warn(
          { conversationId, jobId, reason: gated.reason },
          'Remarketing output blocked by customer-facing gate',
        );
        return 'failed';
      }

      const clientFacingText = stripMarkdownForInstagram(gated.text).trim();
      if (!clientFacingText) {
        await markJob(jobId, 'failed', 'sanitized_empty');
        return 'failed';
      }

      if (!(await isBotTurnStillValid(conversationId, turnStartedAt))) {
        await markJob(jobId, 'cancelled', 'manager_took_over');
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { followUpSentAt: null },
        });
        return 'skipped';
      }

      const postClaude = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { direction: true, sender: true },
      });
      const stillBotLast =
        postClaude[0]?.direction === 'out' && postClaude[0]?.sender !== 'manager';
      if (!stillBotLast) {
        await markJob(jobId, 'cancelled', 'client_or_manager_spoke');
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { followUpSentAt: null },
        });
        return 'skipped';
      }

      if (channel === 'ig' && lastInbound) {
        const inboundAgeMs = Date.now() - lastInbound.createdAt.getTime();
        if (inboundAgeMs > IG_MESSAGING_WINDOW_MS) {
          await markJob(jobId, 'failed', 'ig_window_closed_after_claude');
          log.info({ conversationId, jobId }, 'IG window closed after Claude — no send');
          return 'failed';
        }
      }

      try {
        await sendFollowUpToClient({
          channel,
          igUserId: client.igUserId,
          tgUserId: client.tgUserId,
          text: clientFacingText,
        });
      } catch (err) {
        await markJob(
          jobId,
          'failed',
          isIgOutsideMessagingWindowError(err)
            ? 'ig_outside_messaging_window'
            : err instanceof Error
              ? err.message
              : 'send_failed',
        );
        log.error(
          {
            err,
            conversationId,
            jobId,
            outsideWindow: isIgOutsideMessagingWindowError(err),
          },
          'Remarketing send failed — job failed (no retry)',
        );
        return 'failed';
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
        prisma.followUpJob.update({
          where: { id: jobId },
          data: { status: 'done', lastError: null },
        }),
      ]);

      markFirstOutboundAt(conversationId).catch((err) =>
        log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
      );

      log.info(
        { conversationId, jobId, channel: conversation.channel },
        'Silence remarketing follow-up sent via agent',
      );
      return 'sent';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markJob(jobId, 'failed', msg).catch(() => undefined);
      log.error({ err, conversationId, jobId }, 'Remarketing follow-up crashed');
      return 'failed';
    }
  });
}

/**
 * Lightweight due-job pass — only rows with status=pending AND runAt<=now.
 * Does not scan all conversations.
 */
export async function runFollowUpDuePass(): Promise<FollowUpStats> {
  const stats: FollowUpStats = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    consumed: 0,
  };

  if (!config.FOLLOW_UP_JOB_ENABLED) {
    return stats;
  }

  const followCfg = await getFollowUpConfig();
  if (!followCfg.enabled) {
    return stats;
  }

  const now = new Date();
  const due = await prisma.followUpJob.findMany({
    where: {
      status: 'pending',
      runAt: { lte: now },
    },
    orderBy: { runAt: 'asc' },
    take: config.FOLLOW_UP_BATCH_SIZE,
    select: { id: true, conversationId: true, attemptCount: true },
  });

  stats.scanned = due.length;

  for (const row of due) {
    const claimed = await prisma.followUpJob.updateMany({
      where: { id: row.id, status: 'pending' },
      data: {
        status: 'processing',
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      stats.skipped += 1;
      continue;
    }

    const outcome = await processFollowUpJob(row.id, row.conversationId);
    if (outcome === 'sent') stats.sent += 1;
    else if (outcome === 'failed') {
      stats.failed += 1;
      stats.consumed += 1;
    } else stats.skipped += 1;
  }

  if (stats.sent > 0 || stats.failed > 0 || stats.scanned > 0) {
    log.info(stats, 'Follow-up due pass finished');
  }

  return stats;
}

/** @deprecated alias — prefer runFollowUpDuePass */
export async function runFollowUpPass(): Promise<FollowUpStats> {
  return runFollowUpDuePass();
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function startFollowUpMonitor(logger?: FastifyBaseLogger): void {
  if (!config.FOLLOW_UP_JOB_ENABLED) {
    logger?.info('Follow-up monitor disabled (FOLLOW_UP_JOB_ENABLED=false)');
    return;
  }

  const intervalMs = config.FOLLOW_UP_INTERVAL_MIN * 60 * 1000;

  const run = () => {
    void runFollowUpDuePass().catch((err) => {
      log.error({ err }, 'Follow-up due pass crashed');
    });
  };

  run();
  monitorTimer = setInterval(run, intervalMs);
  logger?.info(
    {
      intervalMin: config.FOLLOW_UP_INTERVAL_MIN,
      batchSize: config.FOLLOW_UP_BATCH_SIZE,
      igMessagingWindowHours: IG_MESSAGING_WINDOW_MS / (60 * 60 * 1000),
      mode: 'due_jobs_queue',
    },
    'Follow-up monitor started (due-jobs queue)',
  );
}

export function stopFollowUpMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
