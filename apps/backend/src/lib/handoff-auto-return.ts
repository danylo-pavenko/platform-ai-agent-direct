import pino from 'pino';
import { prisma } from './prisma.js';
import {
  DEFAULT_HANDOFF_RETURN_TO_BOT_MINUTES,
  getHandoffReturnToBotMinutes,
} from './handoff-settings.js';
import { getAgentConfig } from './agent-config.js';
import { getWorkingHours } from '../services/prompt-builder.js';
import { elapsedWorkingMs } from './working-time.js';
import { ADS_ONLY_ORGANIC_HANDOFF_REASON } from './ig-ad-referral.js';
import { cancelPendingHandoffSlaJobs } from './handoff-sla-schedule.js';

const log = pino({ name: 'handoff-auto-return' });

type HandoffTimingConversation = {
  id: string;
  state: string;
  handedOffAt: Date | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  handoffReason?: string | null;
};

export function effectiveHandoffStartedAt(conversation: {
  handedOffAt: Date | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}): Date {
  return conversation.handedOffAt ?? conversation.lastMessageAt ?? conversation.createdAt;
}

/** Idle timer starts at handoff, or last manager reply if later. */
export async function getHandoffIdleStartedAt(
  conversation: HandoffTimingConversation,
): Promise<Date> {
  const handedOff = effectiveHandoffStartedAt(conversation);
  const lastManager = await prisma.message.findFirst({
    where: { conversationId: conversation.id, sender: 'manager' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!lastManager) return handedOff;
  return lastManager.createdAt > handedOff ? lastManager.createdAt : handedOff;
}

export function isHandoffIdleExpiredAt(
  idleStartedAt: Date,
  timeoutMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  if (timeoutMinutes <= 0) return false;
  return nowMs - idleStartedAt.getTime() >= timeoutMinutes * 60_000;
}

export function isHandoffIdleExpired(
  conversation: {
    handedOffAt: Date | null;
    lastMessageAt: Date | null;
    createdAt: Date;
  },
  timeoutMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  return isHandoffIdleExpiredAt(effectiveHandoffStartedAt(conversation), timeoutMinutes, nowMs);
}

export function isAdsOnlyOrganicHandoffReason(reason: string | null | undefined): boolean {
  return reason === ADS_ONLY_ORGANIC_HANDOFF_REASON;
}

/**
 * If handoff idle/SLA timeout elapsed, return the conversation to the bot.
 * Ads-only organic uses working-hours SLA; other handoffs use wall-clock TTL.
 * @returns true when state was switched back to `bot`.
 */
export async function autoReturnHandoffToBotIfExpired(
  conversation: HandoffTimingConversation,
): Promise<boolean> {
  if (conversation.state !== 'handoff') return false;

  const idleStartedAt = await getHandoffIdleStartedAt(conversation);
  const adsOnly = isAdsOnlyOrganicHandoffReason(conversation.handoffReason);

  if (adsOnly) {
    const [agentCfg, hours] = await Promise.all([getAgentConfig(), getWorkingHours()]);
    const slaHours = agentCfg.managerSlaHoursBusiness;
    if (!(slaHours > 0)) return false;
    const elapsed = elapsedWorkingMs(
      idleStartedAt,
      new Date(),
      hours,
      agentCfg.timezone,
    );
    if (elapsed < slaHours * 60 * 60_000) return false;
  } else {
    const timeoutMinutes = await getHandoffReturnToBotMinutes();
    if (timeoutMinutes <= 0) return false;
    if (!isHandoffIdleExpiredAt(idleStartedAt, timeoutMinutes)) return false;
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      state: 'bot',
      handedOffTo: null,
      handedOffAt: null,
      handoffReason: null,
      ...(adsOnly ? { adsOnlyBotAssumedAt: new Date() } : {}),
    },
  });

  if (adsOnly) {
    await cancelPendingHandoffSlaJobs(conversation.id, 'inbound_sla_reclaim').catch(() => undefined);
  }

  log.info(
    {
      conversationId: conversation.id,
      adsOnly,
      timeoutMinutes: adsOnly
        ? null
        : (await getHandoffReturnToBotMinutes()) || DEFAULT_HANDOFF_RETURN_TO_BOT_MINUTES,
      handedOffAt: conversation.handedOffAt?.toISOString() ?? null,
    },
    adsOnly
      ? 'Ads-only working SLA — conversation returned to bot'
      : 'Handoff idle timeout — conversation returned to bot',
  );

  return true;
}

/** Shared reclaim used by dual-SLA worker (sets exemption). */
export async function reclaimAdsOnlyHandoffToBot(conversationId: string): Promise<boolean> {
  const updated = await prisma.conversation.updateMany({
    where: {
      id: conversationId,
      state: 'handoff',
      handoffReason: ADS_ONLY_ORGANIC_HANDOFF_REASON,
    },
    data: {
      state: 'bot',
      handedOffTo: null,
      handedOffAt: null,
      handoffReason: null,
      adsOnlyBotAssumedAt: new Date(),
    },
  });
  if (updated.count === 0) return false;
  await cancelPendingHandoffSlaJobs(conversationId, 'sla_job_reclaim');
  return true;
}
