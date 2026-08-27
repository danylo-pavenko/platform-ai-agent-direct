/**
 * Live BeautyPro free_time checks before booking (open day + time in slots).
 */

import pino from 'pino';
import { resolveCrmProvider } from './crm-routing.js';
import { getCrmAdapter } from '../services/crm/index.js';
import {
  BeautyproScheduleError,
  evaluateAnyMasterFreeTimeStatus,
  evaluateMasterFreeTimeStatus,
  type MasterScheduleMismatch,
} from './beautypro-schedule-guard.js';
import { getAgentConfig } from './agent-config.js';

const log = pino({ name: 'booking-schedule-check' });

export type BookingScheduleServiceLine = {
  id: string;
  durationMin: number;
  masterId?: string;
  name?: string;
  startTime?: string;
};

/**
 * Refuse book when CRM free_time says the master has no open day / no such start.
 * Uses the same GET /employees/free_time path as get_available_slots (schedule-aware).
 */
export async function checkBookingMastersSchedule(opts: {
  date: string;
  time: string;
  branchId: string;
  services: BookingScheduleServiceLine[];
  timeZone?: string | null;
}): Promise<MasterScheduleMismatch | null> {
  if (!opts.branchId.trim() || opts.services.length === 0) return null;

  try {
    const provider = await resolveCrmProvider('booking');
    const crm = getCrmAdapter(provider);
    if (!crm.getAvailableSlots) return null;

    const timeZone =
      opts.timeZone?.trim() ||
      (await getAgentConfig().catch(() => null))?.timezone ||
      undefined;

    const withMaster = opts.services.filter((s) => Boolean(s.masterId?.trim()));
    if (withMaster.length === 0) {
      const result = await crm.getAvailableSlots({
        date: opts.date,
        branchId: opts.branchId,
        services: opts.services.map((s) => ({
          id: s.id,
          durationMin: s.durationMin > 0 ? s.durationMin : 60,
        })),
        timeZone,
      });
      const status = evaluateAnyMasterFreeTimeStatus({
        slots: result.slots,
        date: opts.date,
        time: opts.time,
      });
      if (status === 'ok') return null;
      return {
        status,
        masterId: '(any)',
        date: opts.date,
        time: opts.time,
      };
    }

    const grouped = new Map<string, BookingScheduleServiceLine[]>();
    for (const row of withMaster) {
      const id = row.masterId!.trim();
      const list = grouped.get(id) ?? [];
      list.push(row);
      grouped.set(id, list);
    }

    for (const [masterId, lines] of grouped) {
      const start = lines.find((l) => l.startTime?.trim())?.startTime?.trim() || opts.time;
      const result = await crm.getAvailableSlots({
        date: opts.date,
        branchId: opts.branchId,
        services: lines.map((s) => ({
          id: s.id,
          durationMin: s.durationMin > 0 ? s.durationMin : 60,
        })),
        masterId,
        timeZone,
      });

      const status = evaluateMasterFreeTimeStatus({
        slots: result.slots,
        masterId,
        date: opts.date,
        time: start,
      });
      if (status !== 'ok') {
        log.info(
          { masterId, date: opts.date, time: start, status },
          'booking schedule guard rejected',
        );
        return { status, masterId, date: opts.date, time: start };
      }
    }

    return null;
  } catch (err) {
    if (err instanceof BeautyproScheduleError) throw err;
    log.warn({ err }, 'booking schedule check failed — allowing book (fail-open)');
    return null;
  }
}

export function scheduleMismatchToToolResult(mismatch: MasterScheduleMismatch): string {
  return new BeautyproScheduleError(mismatch).toToolResult();
}
