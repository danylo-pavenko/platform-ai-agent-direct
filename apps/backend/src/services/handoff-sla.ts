/**
 * Dual SLA worker for ads-only organic soft-handoff:
 * TG manager nudge + reclaim bot + Claude дожим without waiting for new inbound.
 */
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { ADS_ONLY_ORGANIC_HANDOFF_REASON, ADS_ONLY_SLA_RESUME_HINT } from '../lib/ig-ad-referral.js';
import { IG_MESSAGING_WINDOW_MS } from '../lib/follow-up-eval.js';
import { reclaimAdsOnlyHandoffToBot } from '../lib/handoff-auto-return.js';
import { runConversationTurnSerialized } from '../lib/conversation-turn-queue.js';
import { isClaudeBackgroundSpawnBlocked } from '../lib/claude-quota-gate.js';
import { loadClaudeUsageSnapshot } from './claude-usage-monitor.js';
import { notifyHandoffFollowUp } from './telegram-notify.js';

const log = pino({ name: 'handoff-sla' });

async function markJob(
  jobId: string,
  status: 'done' | 'cancelled' | 'failed',
  lastError?: string,
): Promise<void> {
  await prisma.handoffSlaJob.update({
    where: { id: jobId },
    data: {
      status,
      lastError: lastError ? lastError.slice(0, 500) : null,
    },
  });
}

async function processAdsOnlySlaJob(
  jobId: string,
  conversationId: string,
): Promise<'sent' | 'skipped' | 'failed'> {
  return runConversationTurnSerialized(conversationId, async () => {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { client: true },
    });

    if (!conversation) {
      await markJob(jobId, 'cancelled', 'conversation_missing');
      return 'skipped';
    }

    if (
      conversation.state !== 'handoff'
      || conversation.handoffReason !== ADS_ONLY_ORGANIC_HANDOFF_REASON
    ) {
      await markJob(jobId, 'cancelled', 'not_ads_only_handoff');
      return 'skipped';
    }

    const handedOffAt = conversation.handedOffAt ?? conversation.createdAt;
    const managerAfter = await prisma.message.findFirst({
      where: {
        conversationId,
        sender: 'manager',
        createdAt: { gt: handedOffAt },
      },
      select: { id: true },
    });
    if (managerAfter) {
      await markJob(jobId, 'cancelled', 'manager_replied');
      return 'skipped';
    }

    const lastClient = await prisma.message.findFirst({
      where: { conversationId, sender: 'client', direction: 'in' },
      orderBy: { createdAt: 'desc' },
      select: { text: true, createdAt: true, mediaAttachments: true },
    });
    if (!lastClient) {
      await markJob(jobId, 'cancelled', 'no_client_inbound');
      return 'skipped';
    }

    const agentCfg = await getAgentConfig();
    const channel = conversation.channel === 'tg' ? 'tg' : 'ig';
    const inboundAgeMs = Date.now() - lastClient.createdAt.getTime();
    const outsideIgWindow =
      channel === 'ig' && (inboundAgeMs > IG_MESSAGING_WINDOW_MS || inboundAgeMs < 0);

    const clientText = (lastClient.text ?? '').trim() || '[медіа / порожнє повідомлення]';
    const { client } = conversation;

    // Manager side: SLA nudge even if IG window closed.
    if (client.igUserId || client.tgUserId) {
      try {
        await notifyHandoffFollowUp({
          conversationId,
          clientIgUserId: client.igUserId ?? client.tgUserId ?? '',
          clientDisplayName: client.displayName,
          clientIgUsername: client.igUsername,
          text: clientText,
          slaHours: agentCfg.managerSlaHoursBusiness,
        });
      } catch (err) {
        log.warn({ err, conversationId }, 'Ads-only SLA TG nudge failed');
      }
    }

    if (outsideIgWindow) {
      await prisma.message.create({
        data: {
          conversationId,
          direction: 'system',
          sender: 'system',
          text: '⏱ SLA: клієнт чекає довше SLA, але вікно Instagram (~24 год) вже закрите — бот не може написати. Перевірте в адмінці.',
        },
      });
      await markJob(jobId, 'done', 'outside_messaging_window_tg_only');
      return 'skipped';
    }

    const reclaimed = await reclaimAdsOnlyHandoffToBot(conversationId);
    if (!reclaimed) {
      await markJob(jobId, 'cancelled', 'reclaim_lost');
      return 'skipped';
    }

    await prisma.message.create({
      data: {
        conversationId,
        direction: 'system',
        sender: 'system',
        text: '⏱ Dual SLA: менеджер не відповів — бот підхопив органічний тред (режим лише реклама) і відповідає клієнту.',
      },
    });

    const syntheticUser = `${ADS_ONLY_SLA_RESUME_HINT}\n\nОстаннє повідомлення клієнта (відповідай на нього):\n"${clientText}"`;

    try {
      const { handleIncomingMessageForAdsOnlySlaReclaim } = await import(
        './conversation.js'
      );
      const outcome = await handleIncomingMessageForAdsOnlySlaReclaim(
        conversationId,
        syntheticUser,
      );
      if (outcome === 'failed') {
        await markJob(jobId, 'failed', 'claude_failed');
        return 'failed';
      }
      await markJob(jobId, 'done');
      return outcome === 'completed' ? 'sent' : 'skipped';
    } catch (err) {
      log.error({ err, conversationId, jobId }, 'Ads-only SLA reclaim Claude failed');
      await markJob(jobId, 'failed', err instanceof Error ? err.message : 'error');
      return 'failed';
    }
  });
}

export async function runAdsOnlySlaDuePass(): Promise<{
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}> {
  const stats = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

  const usageSnap = await loadClaudeUsageSnapshot().catch(() => null);
  const quota = isClaudeBackgroundSpawnBlocked(
    usageSnap,
    Date.now(),
    config.CLAUDE_QUOTA_SOFT_PERCENT,
  );
  if (quota.blocked) {
    log.info({ reason: quota.reason }, 'Skipping ads-only SLA pass — Claude quota');
    return stats;
  }

  const now = new Date();
  const due = await prisma.handoffSlaJob.findMany({
    where: { status: 'pending', runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
    take: config.FOLLOW_UP_BATCH_SIZE,
    select: { id: true, conversationId: true },
  });
  stats.scanned = due.length;

  for (const row of due) {
    const claimed = await prisma.handoffSlaJob.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'processing', attemptCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      stats.skipped += 1;
      continue;
    }
    const outcome = await processAdsOnlySlaJob(row.id, row.conversationId);
    if (outcome === 'sent') stats.sent += 1;
    else if (outcome === 'failed') stats.failed += 1;
    else stats.skipped += 1;
  }

  if (stats.scanned > 0) {
    log.info(stats, 'Ads-only SLA due pass finished');
  }
  return stats;
}

/** Hook into the follow-up monitor interval. */
export function attachAdsOnlySlaToFollowUpMonitor(logger?: FastifyBaseLogger): void {
  const intervalMs = config.FOLLOW_UP_INTERVAL_MIN * 60 * 1000;
  const run = () => {
    void runAdsOnlySlaDuePass().catch((err) => {
      log.error({ err }, 'Ads-only SLA due pass crashed');
    });
  };
  run();
  setInterval(run, intervalMs);
  logger?.info(
    { intervalMin: config.FOLLOW_UP_INTERVAL_MIN },
    'Ads-only dual SLA monitor started',
  );
}
