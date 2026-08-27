/**
 * BeautyPro schedule / open-day guard.
 * GET /employees/free_time already respects work calendar (closed day → no slots).
 * force=true on POST /appointments can still write into nonWorkingTime — we refuse first.
 */

import type { CrmSlot } from '../services/crm/types.js';
import {
  normalizeToUaDate,
  parseAgentDate,
  toIsoDate,
  toUaDate,
} from '../services/crm/beautypro-free-time.js';
import { normalizeSlotTimeKey } from './booking-time-conflict.js';

export type MasterScheduleStatus = 'ok' | 'day_closed' | 'slot_unavailable';

export type MasterScheduleMismatch = {
  status: Exclude<MasterScheduleStatus, 'ok'>;
  masterId: string;
  date: string;
  time: string;
};

/** Day keys free_time may use (ISO or UA). */
export function freeTimeDayKeysFor(date: string): string[] {
  const parts = parseAgentDate(date);
  if (!parts) return [date.trim()];
  return [...new Set([toUaDate(parts), toIsoDate(parts), normalizeToUaDate(date)])];
}

/**
 * Does free_time show this professional working that day, and is `time` a free start?
 * Empty day for the master → day_closed (графі / no schedule opened).
 * Day has other hours but not this time → slot_unavailable (busy or outside shift).
 */
export function evaluateMasterFreeTimeStatus(opts: {
  slots: Record<string, CrmSlot[]>;
  masterId: string;
  date: string;
  time: string;
}): MasterScheduleStatus {
  const masterId = opts.masterId.trim();
  if (!masterId) return 'ok';
  const timeKey = normalizeSlotTimeKey(opts.time);
  const dayKeys = freeTimeDayKeysFor(opts.date);

  let dayHasAny = false;
  let timeHit = false;

  for (const day of dayKeys) {
    const daySlots = opts.slots[day] ?? [];
    for (const slot of daySlots) {
      if (!slot.masterIds.includes(masterId)) continue;
      dayHasAny = true;
      if (normalizeSlotTimeKey(slot.time) === timeKey) {
        timeHit = true;
      }
    }
  }

  if (!dayHasAny) return 'day_closed';
  if (!timeHit) return 'slot_unavailable';
  return 'ok';
}

/** Any professional free at this clock time that day (no preferred master). */
export function evaluateAnyMasterFreeTimeStatus(opts: {
  slots: Record<string, CrmSlot[]>;
  date: string;
  time: string;
}): MasterScheduleStatus {
  const timeKey = normalizeSlotTimeKey(opts.time);
  const dayKeys = freeTimeDayKeysFor(opts.date);

  let dayHasAny = false;
  let timeHit = false;

  for (const day of dayKeys) {
    const daySlots = opts.slots[day] ?? [];
    for (const slot of daySlots) {
      if (slot.masterIds.length === 0) continue;
      dayHasAny = true;
      if (normalizeSlotTimeKey(slot.time) === timeKey) {
        timeHit = true;
      }
    }
  }

  if (!dayHasAny) return 'day_closed';
  if (!timeHit) return 'slot_unavailable';
  return 'ok';
}

export function formatMasterScheduleMismatchToolResult(
  mismatch: MasterScheduleMismatch,
): string {
  if (mismatch.status === 'day_closed') {
    return [
      `[book_appointment] failed MASTER_DAY_CLOSED — у CRM немає відкритого графіка / вільних вікон для цього майстра на ${mismatch.date} (день закритий або майстра немає в розкладі).`,
      `master_id=${mismatch.masterId} time=${mismatch.time}`,
      'НЕ кажи клієнту що записано. Зроби get_available_slots на цей або інший день (з/без master_id) і пропонуй лише години з tool.',
    ].join('\n');
  }
  return [
    `[book_appointment] failed SLOT_NOT_AVAILABLE — час ${mismatch.date} ${mismatch.time} відсутній у free_time цього майстра (зайнято або поза зміною).`,
    `master_id=${mismatch.masterId}`,
    'НЕ кажи клієнту що записано. Свіжий get_available_slots і інший слот з результату.',
  ].join('\n');
}

export class BeautyproScheduleError extends Error {
  readonly code: 'MASTER_DAY_CLOSED' | 'SLOT_NOT_AVAILABLE';
  readonly masterId: string;
  readonly date: string;
  readonly time: string;

  constructor(mismatch: MasterScheduleMismatch) {
    const toolResult = formatMasterScheduleMismatchToolResult(mismatch);
    super(toolResult);
    this.name = 'BeautyproScheduleError';
    this.code =
      mismatch.status === 'day_closed' ? 'MASTER_DAY_CLOSED' : 'SLOT_NOT_AVAILABLE';
    this.masterId = mismatch.masterId;
    this.date = mismatch.date;
    this.time = mismatch.time;
  }

  toToolResult(): string {
    return this.message;
  }
}

export function isBeautyproScheduleError(err: unknown): err is BeautyproScheduleError {
  return err instanceof BeautyproScheduleError;
}
