import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from './prisma.js';
import { beginIgTypingIndicator } from '../services/ig-typing-indicator.js';
import { runConversationTurnSerialized } from './conversation-turn-queue.js';
import {
  computeCoalesceDelayMs,
  type PendingInboundMessage,
} from './inbound-coalesce-helpers.js';

export {
  computeCoalesceDelayMs,
  joinInboundBatch,
  type JoinedInboundBatch,
  type PendingInboundMessage,
} from './inbound-coalesce-helpers.js';

const log = pino({ name: 'inbound-coalesce' });

/** Mark inbound rows that should not trigger another bot turn. */
export const CLAUDE_TURN_SKIPPED = 'skipped';

export const MAX_PENDING_INBOUND_BATCH = 20;
export const MAX_DRAIN_ITERATIONS = 3;

interface CoalesceState {
  silenceTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  burstStartedAt: number | null;
  /** True while a flush/drain is running for this conversation. */
  flushing: boolean;
  /** Set when inbound arrived during an in-flight flush — re-arm after. */
  dirty: boolean;
}

const states = new Map<string, CoalesceState>();

function getState(conversationId: string): CoalesceState {
  let state = states.get(conversationId);
  if (!state) {
    state = {
      silenceTimer: null,
      maxWaitTimer: null,
      burstStartedAt: null,
      flushing: false,
      dirty: false,
    };
    states.set(conversationId, state);
  }
  return state;
}

function clearTimers(state: CoalesceState): void {
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }
  if (state.maxWaitTimer) {
    clearTimeout(state.maxWaitTimer);
    state.maxWaitTimer = null;
  }
}

/**
 * Inbound client messages not yet claimed by a Claude turn, after the last
 * real (non-fallback) bot/manager outbound. Optional `onlyAfter` limits to
 * messages that arrived during an in-flight turn (drain follow-up).
 */
export async function loadPendingInbound(
  conversationId: string,
  options?: { onlyAfter?: Date; take?: number },
): Promise<PendingInboundMessage[]> {
  const take = options?.take ?? MAX_PENDING_INBOUND_BATCH;

  const lastRealOutbound = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: 'out',
      OR: [
        { sender: 'manager' },
        { sender: 'bot', botFailureCode: null },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const createdAtFilter: { gt?: Date } = {};
  if (lastRealOutbound) {
    createdAtFilter.gt = lastRealOutbound.createdAt;
  }
  if (options?.onlyAfter) {
    const floor = options.onlyAfter;
    if (!createdAtFilter.gt || floor > createdAtFilter.gt) {
      createdAtFilter.gt = floor;
    }
  }

  return prisma.message.findMany({
    where: {
      conversationId,
      direction: 'in',
      sender: 'client',
      claudeTurnId: null,
      ...(createdAtFilter.gt ? { createdAt: createdAtFilter } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take,
    select: {
      id: true,
      text: true,
      mediaUrls: true,
      mediaAttachments: true,
      sharedPost: true,
      igMessageId: true,
      createdAt: true,
    },
  });
}

export async function claimInboundMessages(
  messageIds: string[],
  turnId: string,
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const result = await prisma.message.updateMany({
    where: { id: { in: messageIds }, claudeTurnId: null },
    data: { claudeTurnId: turnId },
  });
  return result.count;
}

export async function releaseInboundClaim(turnId: string): Promise<void> {
  await prisma.message.updateMany({
    where: { claudeTurnId: turnId },
    data: { claudeTurnId: null },
  });
}

export async function markInboundSkipped(turnId: string): Promise<void> {
  await prisma.message.updateMany({
    where: { claudeTurnId: turnId },
    data: { claudeTurnId: CLAUDE_TURN_SKIPPED },
  });
}

/** Clear claims so retry can re-process unanswered inbounds. */
export async function clearInboundClaims(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await prisma.message.updateMany({
    where: { id: { in: messageIds } },
    data: { claudeTurnId: null },
  });
}

async function bootstrapTyping(conversationId: string): Promise<void> {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        channel: true,
        client: { select: { igUserId: true } },
      },
    });
    if (!conversation?.client.igUserId) return;
    await beginIgTypingIndicator({
      channel: conversation.channel,
      recipientId: conversation.client.igUserId,
    });
  } catch (err) {
    log.warn({ err, conversationId }, 'Coalesce typing bootstrap failed (non-fatal)');
  }
}

async function flushConversation(conversationId: string): Promise<void> {
  const state = getState(conversationId);
  clearTimers(state);
  state.burstStartedAt = null;
  state.flushing = true;
  state.dirty = false;

  try {
    const { drainPendingInboundTurns } = await import('../services/conversation.js');
    await runConversationTurnSerialized(conversationId, () =>
      drainPendingInboundTurns(conversationId),
    );
  } finally {
    state.flushing = false;
    if (state.dirty) {
      state.dirty = false;
      if (config.INBOUND_COALESCE_ENABLED) {
        armTimers(conversationId);
      } else {
        void flushConversation(conversationId).catch((err) => {
          log.error({ err, conversationId }, 'Re-flush after dirty inbound failed');
        });
      }
    }
  }
}

function armTimers(conversationId: string): void {
  const state = getState(conversationId);
  const now = Date.now();
  if (state.burstStartedAt == null) {
    state.burstStartedAt = now;
    void bootstrapTyping(conversationId);
  }

  clearTimers(state);

  const delay = computeCoalesceDelayMs(
    now,
    state.burstStartedAt,
    config.INBOUND_COALESCE_SILENCE_MS,
    config.INBOUND_COALESCE_MAX_WAIT_MS,
  );

  const fire = () => {
    clearTimers(state);
    state.burstStartedAt = null;
    void flushConversation(conversationId).catch((err) => {
      log.error({ err, conversationId }, 'Inbound coalesce flush failed');
    });
  };

  state.silenceTimer = setTimeout(fire, delay);
  const maxRemaining = Math.max(
    0,
    state.burstStartedAt + config.INBOUND_COALESCE_MAX_WAIT_MS - now,
  );
  if (maxRemaining < delay) {
    state.maxWaitTimer = setTimeout(fire, maxRemaining);
  }
}

/**
 * Schedule a coalesced bot turn after inbound persist.
 * When coalesce is disabled, flushes immediately (still via drain).
 */
export function scheduleInboundBotTurn(conversationId: string): void {
  const state = getState(conversationId);

  if (state.flushing) {
    state.dirty = true;
    return;
  }

  if (!config.INBOUND_COALESCE_ENABLED) {
    void flushConversation(conversationId).catch((err) => {
      log.error({ err, conversationId }, 'Immediate inbound flush failed');
    });
    return;
  }

  armTimers(conversationId);
}

/**
 * Flush pending inbound immediately (retry worker / tests).
 * Still serialized per conversation.
 */
export async function flushInboundBotTurnNow(conversationId: string): Promise<void> {
  const state = getState(conversationId);
  clearTimers(state);
  state.burstStartedAt = null;
  state.dirty = false;
  await flushConversation(conversationId);
}

/** Test helper — clear in-memory debounce state. */
export function resetInboundCoalesceStateForTests(): void {
  for (const state of states.values()) {
    clearTimers(state);
  }
  states.clear();
}

export function newClaudeTurnId(): string {
  return randomUUID();
}
