/**
 * Follow-up job scheduling — plan remarketing at bot outbound time,
 * cancel on client inbound / handoff. Worker only loads due rows.
 */
import pino from 'pino';
import { config } from '../config.js';
import { prisma } from './prisma.js';
import {
  getFollowUpConfig,
  invalidateFollowUpConfigCache,
  normalizeFollowUpConfig,
  type FollowUpConfig,
} from './follow-up-config.js';

const log = pino({ name: 'follow-up-schedule' });

export async function cancelPendingFollowUps(
  conversationId: string,
  reason?: string,
): Promise<number> {
  const result = await prisma.followUpJob.updateMany({
    where: { conversationId, status: 'pending' },
    data: {
      status: 'cancelled',
      lastError: reason ? reason.slice(0, 500) : null,
    },
  });
  if (result.count > 0) {
    log.info(
      { conversationId, count: result.count, reason: reason ?? null },
      'Cancelled pending follow-up jobs',
    );
  }
  return result.count;
}

/**
 * After a live bot outbound (not remarketing itself): schedule one pending job
 * at now + delayHours. Replaces any existing pending job for this conversation.
 */
export async function scheduleFollowUpAfterBotOutbound(
  conversationId: string,
  scheduledFrom: Date = new Date(),
): Promise<void> {
  if (!config.FOLLOW_UP_JOB_ENABLED) return;

  const followCfg = await getFollowUpConfig();
  if (!followCfg.enabled) return;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      state: true,
      channel: true,
      followUpSentAt: true,
    },
  });

  if (!conversation) return;
  if (conversation.state !== 'bot') return;
  if (conversation.channel !== 'ig' && conversation.channel !== 'tg') return;
  // Already nudged this silence cycle — wait for client inbound to clear.
  if (conversation.followUpSentAt) return;

  const delayMs = followCfg.delayHours * 60 * 60_000;
  const runAt = new Date(scheduledFrom.getTime() + delayMs);

  await prisma.$transaction(async (tx) => {
    await tx.followUpJob.updateMany({
      where: { conversationId, status: 'pending' },
      data: { status: 'cancelled', lastError: 'rescheduled_after_bot_outbound' },
    });
    await tx.followUpJob.create({
      data: {
        conversationId,
        runAt,
        scheduledFrom,
        status: 'pending',
      },
    });
  });

  log.info(
    {
      conversationId,
      runAt: runAt.toISOString(),
      delayHours: followCfg.delayHours,
    },
    'Scheduled follow-up job after bot outbound',
  );
}

/** Fire-and-forget wrapper for hot paths (never throw into bot send). */
export function scheduleFollowUpAfterBotOutboundSafe(
  conversationId: string,
  scheduledFrom?: Date,
): void {
  void scheduleFollowUpAfterBotOutbound(conversationId, scheduledFrom).catch((err) => {
    log.warn({ err, conversationId }, 'scheduleFollowUpAfterBotOutbound failed (non-fatal)');
  });
}

export function cancelPendingFollowUpsSafe(
  conversationId: string,
  reason?: string,
): void {
  void cancelPendingFollowUps(conversationId, reason).catch((err) => {
    log.warn({ err, conversationId }, 'cancelPendingFollowUps failed (non-fatal)');
  });
}

/**
 * When admin changes delayHours, recompute runAt for all pending jobs
 * from their scheduledFrom timestamps.
 */
export async function reschedulePendingFollowUpsForDelay(
  delayHours: number,
): Promise<number> {
  const delayMs = delayHours * 60 * 60_000;
  const pending = await prisma.followUpJob.findMany({
    where: { status: 'pending' },
    select: { id: true, scheduledFrom: true },
  });

  if (pending.length === 0) return 0;

  await prisma.$transaction(
    pending.map((job) =>
      prisma.followUpJob.update({
        where: { id: job.id },
        data: { runAt: new Date(job.scheduledFrom.getTime() + delayMs) },
      }),
    ),
  );

  log.info(
    { count: pending.length, delayHours },
    'Rescheduled pending follow-up jobs for new delay',
  );
  return pending.length;
}

/** After saving follow_up_config — invalidate cache and maybe reschedule. */
export async function onFollowUpConfigSaved(
  previous: FollowUpConfig | null,
  nextRaw: unknown,
): Promise<void> {
  invalidateFollowUpConfigCache();
  const next = normalizeFollowUpConfig(
    (nextRaw ?? {}) as Partial<FollowUpConfig>,
  );

  if (!next.enabled) {
    const cancelled = await prisma.followUpJob.updateMany({
      where: { status: 'pending' },
      data: { status: 'cancelled', lastError: 'follow_up_disabled' },
    });
    if (cancelled.count > 0) {
      log.info({ count: cancelled.count }, 'Cancelled pending jobs — follow-up disabled');
    }
    return;
  }

  if (!previous || previous.delayHours !== next.delayHours) {
    await reschedulePendingFollowUpsForDelay(next.delayHours);
  }
}
