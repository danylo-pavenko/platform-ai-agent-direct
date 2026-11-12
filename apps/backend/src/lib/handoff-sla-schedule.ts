/**
 * Dual SLA jobs for ads-only organic soft-handoff:
 * schedule reclaim+TG nudge at working-hours SLA; cancel on manager reply / reclaim.
 */
import pino from 'pino';
import { prisma } from './prisma.js';
import { getAgentConfig } from './agent-config.js';
import { getWorkingHours } from '../services/prompt-builder.js';
import { utcAfterWorkingHours } from './working-time.js';
import { ADS_ONLY_ORGANIC_HANDOFF_REASON } from './ig-ad-referral.js';

const log = pino({ name: 'handoff-sla-schedule' });

export async function cancelPendingHandoffSlaJobs(
  conversationId: string,
  reason?: string,
): Promise<number> {
  const result = await prisma.handoffSlaJob.updateMany({
    where: { conversationId, status: 'pending' },
    data: {
      status: 'cancelled',
      lastError: reason ? reason.slice(0, 500) : null,
    },
  });
  if (result.count > 0) {
    log.info(
      { conversationId, count: result.count, reason: reason ?? null },
      'Cancelled pending handoff SLA jobs',
    );
  }
  return result.count;
}

export function cancelPendingHandoffSlaJobsSafe(
  conversationId: string,
  reason?: string,
): void {
  void cancelPendingHandoffSlaJobs(conversationId, reason).catch((err) => {
    log.warn({ err, conversationId }, 'cancelPendingHandoffSlaJobs failed (non-fatal)');
  });
}

/** Schedule dual-SLA due time from now using managerSlaHoursBusiness working clock. */
export async function scheduleAdsOnlyHandoffSlaJob(
  conversationId: string,
  scheduledFrom: Date = new Date(),
): Promise<void> {
  const [agentCfg, hours] = await Promise.all([getAgentConfig(), getWorkingHours()]);
  const slaHours = agentCfg.managerSlaHoursBusiness;
  if (!(slaHours > 0)) return;

  const runAt = utcAfterWorkingHours(
    scheduledFrom,
    slaHours,
    hours,
    agentCfg.timezone,
  );

  await prisma.$transaction(async (tx) => {
    await tx.handoffSlaJob.updateMany({
      where: { conversationId, status: 'pending' },
      data: { status: 'cancelled', lastError: 'rescheduled_ads_only_sla' },
    });
    await tx.handoffSlaJob.create({
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
      slaHours,
      reason: ADS_ONLY_ORGANIC_HANDOFF_REASON,
    },
    'Scheduled ads-only dual SLA job',
  );
}

export function scheduleAdsOnlyHandoffSlaJobSafe(
  conversationId: string,
  scheduledFrom?: Date,
): void {
  void scheduleAdsOnlyHandoffSlaJob(conversationId, scheduledFrom).catch((err) => {
    log.warn({ err, conversationId }, 'scheduleAdsOnlyHandoffSlaJob failed (non-fatal)');
  });
}

export async function markAdsOnlyBotAssumed(conversationId: string): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { adsOnlyBotAssumedAt: new Date() },
  });
}

export async function clearAdsOnlyBotAssumed(conversationId: string): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { adsOnlyBotAssumedAt: null },
  });
}
