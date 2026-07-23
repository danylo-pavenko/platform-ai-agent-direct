import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { isAgentFallbackReply } from '../lib/agent-fallback.js';
import {
  clearInboundClaims,
  flushInboundBotTurnNow,
} from '../lib/inbound-coalesce.js';
import { getClaudeAuthStatus } from './claude-auth.js';

const log = pino({ name: 'conversation-retry' });

export interface ConversationRetryStats {
  scanned: number;
  attempted: number;
  answered: number;
  skipped: number;
  failed: number;
}

export type RetrySkipReason =
  | 'no_inbound'
  | 'manager_replied'
  | 'real_bot_reply'
  | 'too_soon'
  | 'too_old'
  | 'max_attempts'
  | 'wrong_state'
  | 'claude_unavailable';

export interface MessageForRetryEval {
  direction: string;
  sender: string;
  text: string | null;
  createdAt: Date;
}

export interface RetryEvalResult {
  needed: boolean;
  reason: RetrySkipReason | 'ok';
  inboundAt: Date | null;
}

/** Pure helper — decides if the bot should re-process the last client message. */
export function evaluateConversationRetryNeed(
  messages: MessageForRetryEval[],
  nowMs: number,
  opts: {
    minAgeMs: number;
    maxAgeMs: number;
    maxBotAttemptsAfterInbound: number;
  },
): RetryEvalResult {
  const inboundMessages = messages
    .filter((m) => m.direction === 'in' && m.sender === 'client')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const lastInbound = inboundMessages.at(-1);
  if (!lastInbound) {
    return { needed: false, reason: 'no_inbound', inboundAt: null };
  }

  const inboundAt = lastInbound.createdAt;
  const ageMs = nowMs - inboundAt.getTime();
  if (ageMs < opts.minAgeMs) {
    return { needed: false, reason: 'too_soon', inboundAt };
  }
  if (ageMs > opts.maxAgeMs) {
    return { needed: false, reason: 'too_old', inboundAt };
  }

  const repliesAfter = messages.filter(
    (m) =>
      m.createdAt > inboundAt &&
      m.direction === 'out' &&
      (m.sender === 'bot' || m.sender === 'manager'),
  );

  if (repliesAfter.some((m) => m.sender === 'manager')) {
    return { needed: false, reason: 'manager_replied', inboundAt };
  }

  const botReplies = repliesAfter.filter((m) => m.sender === 'bot');
  if (botReplies.some((m) => m.text && !isAgentFallbackReply(m.text))) {
    return { needed: false, reason: 'real_bot_reply', inboundAt };
  }

  if (botReplies.length >= opts.maxBotAttemptsAfterInbound) {
    return { needed: false, reason: 'max_attempts', inboundAt };
  }

  return { needed: true, reason: 'ok', inboundAt };
}

const inFlight = new Set<string>();

/** Re-run the bot turn for unanswered client inbound messages in a conversation. */
export async function retryConversationBotReply(conversationId: string): Promise<boolean> {
  if (inFlight.has(conversationId)) {
    return false;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, state: true, channel: true },
  });

  if (!conversation || conversation.state !== 'bot') {
    return false;
  }
  if (conversation.channel !== 'ig' && conversation.channel !== 'tg') {
    return false;
  }

  const recentMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      direction: true,
      sender: true,
      text: true,
      createdAt: true,
      igMessageId: true,
    },
  });

  const evalResult = evaluateConversationRetryNeed(recentMessages, Date.now(), {
    minAgeMs: config.CONVERSATION_RETRY_MIN_AGE_MS,
    maxAgeMs: config.CONVERSATION_RETRY_MAX_AGE_MS,
    maxBotAttemptsAfterInbound: config.CONVERSATION_RETRY_MAX_BOT_ATTEMPTS,
  });

  if (!evalResult.needed || !evalResult.inboundAt) {
    return false;
  }

  // Clear claims on unanswered inbounds so coalesce drain can pick them up.
  const inboundAt = evalResult.inboundAt;
  const toClear = recentMessages
    .filter(
      (m) =>
        m.direction === 'in' &&
        m.sender === 'client' &&
        m.createdAt >= inboundAt,
    )
    .map((m) => m.id);
  // Also clear earlier unclaimed-or-claimed inbounds after the previous real reply:
  // include all client inbounds with no real bot reply after them, from the
  // unanswered streak ending at lastInbound.
  const unansweredIds = recentMessages
    .filter((m) => m.direction === 'in' && m.sender === 'client')
    .filter((m) => {
      const hasRealReplyAfter = recentMessages.some(
        (r) =>
          r.createdAt > m.createdAt &&
          r.direction === 'out' &&
          ((r.sender === 'bot' && r.text && !isAgentFallbackReply(r.text)) ||
            r.sender === 'manager'),
      );
      return !hasRealReplyAfter;
    })
    .map((m) => m.id);

  const claimClearIds = [...new Set([...toClear, ...unansweredIds])];

  inFlight.add(conversationId);
  try {
    log.info(
      {
        event: 'conversation_retry_start',
        conversationId,
        inboundAgeMs: Date.now() - inboundAt.getTime(),
        clearCount: claimClearIds.length,
      },
      'Retrying bot reply for unanswered client message',
    );

    await clearInboundClaims(claimClearIds);
    await flushInboundBotTurnNow(conversationId);

    const afterMessages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { direction: true, sender: true, text: true, createdAt: true },
    });

    const afterEval = evaluateConversationRetryNeed(afterMessages, Date.now(), {
      minAgeMs: 0,
      maxAgeMs: config.CONVERSATION_RETRY_MAX_AGE_MS,
      maxBotAttemptsAfterInbound: config.CONVERSATION_RETRY_MAX_BOT_ATTEMPTS,
    });

    const answered =
      afterEval.reason === 'real_bot_reply' || afterEval.reason === 'manager_replied';

    log.info(
      {
        event: 'conversation_retry_done',
        conversationId,
        answered,
        afterReason: afterEval.reason,
      },
      answered ? 'Conversation retry produced a real reply' : 'Conversation retry finished without real reply',
    );

    return answered;
  } catch (err) {
    log.error({ err, conversationId }, 'Conversation retry failed');
    return false;
  } finally {
    inFlight.delete(conversationId);
  }
}

/** Scan active bot conversations and retry those still waiting on the agent. */
export async function runConversationRetryPass(): Promise<ConversationRetryStats> {
  const stats: ConversationRetryStats = {
    scanned: 0,
    attempted: 0,
    answered: 0,
    skipped: 0,
    failed: 0,
  };

  if (!config.CONVERSATION_RETRY_ENABLED) {
    return stats;
  }

  const auth = await getClaudeAuthStatus();
  if (!auth.loggedIn || !auth.binaryOk) {
    log.debug(
      { loggedIn: auth.loggedIn, binaryOk: auth.binaryOk, error: auth.error },
      'Skipping conversation retry pass — Claude unavailable',
    );
    return stats;
  }

  const cutoff = new Date(Date.now() - config.CONVERSATION_RETRY_MAX_AGE_MS);
  const conversations = await prisma.conversation.findMany({
    where: {
      state: 'bot',
      channel: { in: ['ig', 'tg'] },
      lastMessageAt: { gte: cutoff },
    },
    orderBy: { lastMessageAt: 'asc' },
    take: config.CONVERSATION_RETRY_BATCH_SIZE,
    select: { id: true },
  });

  stats.scanned = conversations.length;

  for (const { id } of conversations) {
    const recentMessages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        direction: true,
        sender: true,
        text: true,
        createdAt: true,
      },
    });

    const evalResult = evaluateConversationRetryNeed(recentMessages, Date.now(), {
      minAgeMs: config.CONVERSATION_RETRY_MIN_AGE_MS,
      maxAgeMs: config.CONVERSATION_RETRY_MAX_AGE_MS,
      maxBotAttemptsAfterInbound: config.CONVERSATION_RETRY_MAX_BOT_ATTEMPTS,
    });

    if (!evalResult.needed) {
      stats.skipped += 1;
      continue;
    }

    stats.attempted += 1;
    const ok = await retryConversationBotReply(id);
    if (ok) stats.answered += 1;
    else stats.failed += 1;
  }

  if (stats.attempted > 0) {
    log.info(stats, 'Conversation retry pass finished');
  }

  return stats;
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function startConversationRetryMonitor(logger?: FastifyBaseLogger): void {
  if (!config.CONVERSATION_RETRY_ENABLED) {
    logger?.info('Conversation retry monitor disabled (CONVERSATION_RETRY_ENABLED=false)');
    return;
  }

  const intervalMs = config.CONVERSATION_RETRY_INTERVAL_MIN * 60 * 1000;

  const run = () => {
    void runConversationRetryPass().catch((err) => {
      log.error({ err }, 'Conversation retry pass crashed');
    });
  };

  run();
  monitorTimer = setInterval(run, intervalMs);
  logger?.info(
    {
      intervalMin: config.CONVERSATION_RETRY_INTERVAL_MIN,
      minAgeMs: config.CONVERSATION_RETRY_MIN_AGE_MS,
      maxAgeMs: config.CONVERSATION_RETRY_MAX_AGE_MS,
      batchSize: config.CONVERSATION_RETRY_BATCH_SIZE,
    },
    'Conversation retry monitor started',
  );
}

export function stopConversationRetryMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
