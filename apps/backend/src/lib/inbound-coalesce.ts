import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from './prisma.js';
import { beginIgTypingIndicator } from '../services/ig-typing-indicator.js';
import { runConversationTurnSerialized } from './conversation-turn-queue.js';
import {
  computeCoalesceDelayMs,
  joinInboundBatch,
  looksLikePartialUtterance,
  resolveCoalesceWindowMs,
  resolvePendingInboundFloor,
  shouldBootstrapIgTyping,
  type JoinedInboundBatch,
  type PendingInboundMessage,
} from './inbound-coalesce-helpers.js';

export {
  computeCoalesceDelayMs,
  joinInboundBatch,
  looksLikePartialUtterance,
  resolveCoalesceWindowMs,
  resolvePendingInboundFloor,
  shouldBootstrapIgTyping,
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
  /** Any bubble in this burst looks like a fragment (time / name / phone). */
  partialBurst: boolean;
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
      partialBurst: false,
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
 * Inbound client messages not yet claimed by a Claude turn.
 *
 * Floor is last *claimed* inbound (not last bot outbound) so bubbles that
 * arrived during an in-flight turn are not orphaned when the bot reply is
 * persisted with a later timestamp. Optional `onlyAfter` limits drain
 * follow-ups to mids that arrived during the current turn.
 */
export async function loadPendingInbound(
  conversationId: string,
  options?: { onlyAfter?: Date; take?: number },
): Promise<PendingInboundMessage[]> {
  const take = options?.take ?? MAX_PENDING_INBOUND_BATCH;

  const [lastRealOutbound, lastClaimedInbound] = await Promise.all([
    prisma.message.findFirst({
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
    }),
    prisma.message.findFirst({
      where: {
        conversationId,
        direction: 'in',
        sender: 'client',
        claudeTurnId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  // gte: IG bubbles in the same second as the claimed mid must still be
  // eligible (claimed rows are excluded by claudeTurnId: null).
  const createdAtFilter: { gte?: Date } = {};
  const floor = resolvePendingInboundFloor({
    lastClaimedInboundAt: lastClaimedInbound?.createdAt ?? null,
    lastRealOutboundAt: lastRealOutbound?.createdAt ?? null,
    onlyAfter: options?.onlyAfter,
  });
  if (floor) {
    createdAtFilter.gte = floor;
  }

  return prisma.message.findMany({
    where: {
      conversationId,
      direction: 'in',
      sender: 'client',
      claudeTurnId: null,
      ...(createdAtFilter.gte ? { createdAt: createdAtFilter } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take,
    select: {
      id: true,
      text: true,
      mediaUrls: true,
      mediaAttachments: true,
      sharedPost: true,
      igContext: true,
      igMessageId: true,
      createdAt: true,
    },
  });
}

const PENDING_INBOUND_SELECT = {
  id: true,
  text: true,
  mediaUrls: true,
  mediaAttachments: true,
  sharedPost: true,
  igContext: true,
  igMessageId: true,
  createdAt: true,
} as const;

export async function loadClaimedTurnInbound(turnId: string): Promise<PendingInboundMessage[]> {
  return prisma.message.findMany({
    where: { claudeTurnId: turnId },
    orderBy: { createdAt: 'asc' },
    take: MAX_PENDING_INBOUND_BATCH,
    select: PENDING_INBOUND_SELECT,
  });
}

/**
 * Claim unclaimed inbound that arrived after this turn started and rebuild
 * the joined user message so Claude sees time + name + phone as one utterance.
 */
export async function absorbLateInboundIntoTurn(
  conversationId: string,
  turnId: string,
): Promise<JoinedInboundBatch | null> {
  const extra = await loadPendingInbound(conversationId);
  if (extra.length === 0) return null;
  const claimed = await claimInboundMessages(
    extra.map((m) => m.id),
    turnId,
  );
  if (claimed === 0) return null;
  const all = await loadClaimedTurnInbound(turnId);
  if (all.length === 0) return null;
  return joinInboundBatch(all);
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
        state: true,
        client: { select: { igUserId: true } },
      },
    });
    if (!conversation?.client.igUserId) return;
    // Handoff / closed / paused: never start typing — early skip has no finally end().
    if (!shouldBootstrapIgTyping(conversation.state)) {
      log.debug(
        { conversationId, state: conversation.state },
        'Skipping coalesce typing bootstrap — conversation not in bot state',
      );
      return;
    }
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
  const waitedMs =
    state.burstStartedAt != null ? Date.now() - state.burstStartedAt : null;
  state.burstStartedAt = null;
  state.flushing = true;
  state.dirty = false;
  // Keep partialBurst: inbound during this flush may still be a fragment.

  log.info(
    {
      conversationId,
      waitedMs,
      coalesceEnabled: config.INBOUND_COALESCE_ENABLED,
    },
    'Inbound coalesce flush starting',
  );

  try {
    const { drainPendingInboundTurns } = await import('../services/conversation.js');
    await runConversationTurnSerialized(conversationId, () =>
      drainPendingInboundTurns(conversationId),
    );
    log.info({ conversationId }, 'Inbound coalesce flush finished');
  } catch (err) {
    log.error({ err, conversationId }, 'Inbound coalesce flush threw');
    throw err;
  } finally {
    state.flushing = false;
    if (state.dirty) {
      state.dirty = false;
      log.info(
        {
          conversationId,
          coalesceEnabled: config.INBOUND_COALESCE_ENABLED,
        },
        'Inbound arrived during flush — re-arming coalesce',
      );
      if (config.INBOUND_COALESCE_ENABLED) {
        armTimers(conversationId);
      } else {
        void flushConversation(conversationId).catch((err) => {
          log.error({ err, conversationId }, 'Re-flush after dirty inbound failed');
        });
      }
    } else {
      state.partialBurst = false;
    }
  }
}

function armTimers(conversationId: string): void {
  const state = getState(conversationId);
  const now = Date.now();
  const isNewBurst = state.burstStartedAt == null;
  if (isNewBurst) {
    state.burstStartedAt = now;
    void bootstrapTyping(conversationId);
  }

  clearTimers(state);

  const window = resolveCoalesceWindowMs(
    state.partialBurst,
    {
      silenceMs: config.INBOUND_COALESCE_SILENCE_MS,
      maxWaitMs: config.INBOUND_COALESCE_MAX_WAIT_MS,
    },
    {
      silenceMs: config.INBOUND_COALESCE_PARTIAL_SILENCE_MS,
      maxWaitMs: config.INBOUND_COALESCE_PARTIAL_MAX_WAIT_MS,
    },
  );

  const delay = computeCoalesceDelayMs(
    now,
    state.burstStartedAt!,
    window.silenceMs,
    window.maxWaitMs,
  );
  const burstAgeMs = now - state.burstStartedAt!;
  const maxRemaining = Math.max(
    0,
    state.burstStartedAt! + window.maxWaitMs - now,
  );

  log.info(
    {
      conversationId,
      isNewBurst,
      partialBurst: state.partialBurst,
      delayMs: delay,
      burstAgeMs,
      silenceMs: window.silenceMs,
      maxWaitMs: window.maxWaitMs,
      maxRemainingMs: maxRemaining,
      armMaxWaitTimer: maxRemaining < delay,
    },
    'Inbound coalesce timer armed',
  );

  const fire = () => {
    clearTimers(state);
    state.burstStartedAt = null;
    void flushConversation(conversationId).catch((err) => {
      log.error({ err, conversationId }, 'Inbound coalesce flush failed');
    });
  };

  state.silenceTimer = setTimeout(fire, delay);
  if (maxRemaining < delay) {
    state.maxWaitTimer = setTimeout(fire, maxRemaining);
  }
}

function notePartialBurst(state: CoalesceState, text?: string | null): void {
  if (looksLikePartialUtterance(text)) {
    state.partialBurst = true;
  }
}

/**
 * Schedule a coalesced bot turn after inbound persist.
 * When coalesce is disabled, flushes immediately (still via drain).
 */
export function scheduleInboundBotTurn(
  conversationId: string,
  hint?: { text?: string | null },
): void {
  const state = getState(conversationId);
  const isNewBurst = state.burstStartedAt == null && !state.flushing;
  if (isNewBurst) {
    state.partialBurst = looksLikePartialUtterance(hint?.text);
  } else {
    notePartialBurst(state, hint?.text);
  }

  if (state.flushing) {
    state.dirty = true;
    log.info(
      { conversationId, partialBurst: state.partialBurst },
      'Inbound during active flush — marked dirty for re-arm',
    );
    return;
  }

  if (!config.INBOUND_COALESCE_ENABLED) {
    log.info({ conversationId }, 'Inbound coalesce disabled — flushing immediately');
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
