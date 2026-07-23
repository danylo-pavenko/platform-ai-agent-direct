import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getFollowUpConfig } from '../lib/follow-up-config.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  evaluateFollowUpNeed,
  FOLLOW_UP_MAX_AGE_MS,
} from '../lib/follow-up-eval.js';
import { sendText } from './instagram.js';
import { getBot } from '../lib/telegram.js';

export { evaluateFollowUpNeed, FOLLOW_UP_MAX_AGE_MS } from '../lib/follow-up-eval.js';

const log = pino({ name: 'follow-up' });

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

async function sendFollowUpForConversation(
  conversationId: string,
  template: string,
): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { client: true },
  });

  if (!conversation || conversation.state !== 'bot') {
    return false;
  }
  if (conversation.followUpSentAt) {
    return false;
  }

  const text = template.trim();
  if (!text) return false;

  try {
    await sendFollowUpToClient({
      channel: conversation.channel === 'tg' ? 'tg' : 'ig',
      igUserId: conversation.client.igUserId,
      tgUserId: conversation.client.tgUserId,
      text,
    });
  } catch (err) {
    log.error({ err, conversationId }, 'Follow-up send failed');
    return false;
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        direction: 'out',
        sender: 'bot',
        text,
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        followUpSentAt: now,
        lastMessageAt: now,
      },
    }),
  ]);

  markFirstOutboundAt(conversationId).catch((err) =>
    log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
  );

  log.info({ conversationId, channel: conversation.channel }, 'Silence follow-up sent');
  return true;
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

    const ok = await sendFollowUpForConversation(row.id, followCfg.template);
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
