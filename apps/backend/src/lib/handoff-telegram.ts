import { elapsedWorkingMs, type WorkingHoursLike } from './working-time.js';

const MS_PER_HOUR = 60 * 60 * 1000;

export type HandoffFollowUpDecisionInput = {
  waitStartedAt: Date;
  now: Date;
  /** `agent_config.managerSlaHoursBusiness` */
  slaHours: number;
  workingHours: WorkingHoursLike;
  timeZone: string;
  /** Client inbound after `waitStartedAt`, excluding the current coalesced turn. */
  priorClientInboundAt: ReadonlyArray<Date>;
};

/**
 * Telegram during manager handoff: the first `notifyHandoff` card is enough.
 * Do not forward every later client bubble — only one SLA reminder after the
 * client has waited `slaHours` of working time without a manager reply.
 */
export function shouldNotifyHandoffFollowUp(
  input: HandoffFollowUpDecisionInput,
): boolean {
  if (!(input.slaHours > 0)) return false;

  const slaMs = input.slaHours * MS_PER_HOUR;
  if (
    elapsedWorkingMs(
      input.waitStartedAt,
      input.now,
      input.workingHours,
      input.timeZone,
    ) < slaMs
  ) {
    return false;
  }

  for (const at of input.priorClientInboundAt) {
    if (
      elapsedWorkingMs(
        input.waitStartedAt,
        at,
        input.workingHours,
        input.timeZone,
      ) >= slaMs
    ) {
      return false;
    }
  }

  return true;
}
