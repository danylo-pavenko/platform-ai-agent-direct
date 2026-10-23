/**
 * Pick which open booking cancel/reschedule should target when the visit may
 * live only in CRM (manager Instagram) or on another conversation UUID.
 */

import type { CrmUpcomingBooking } from '../services/crm/types.js';
import { parseAgentDate } from '../services/crm/beautypro-free-time.js';
import {
  selectUpcomingVisits,
  todayUaDateSortKey,
  type UpcomingVisitRow,
} from './upcoming-visit.js';
import { getZonedDateTimeParts } from './tenant-timezone.js';

export type LocalBookingCandidate = {
  id: string;
  conversationId: string;
  scheduledDate: string;
  scheduledTime: string;
  crmRecordId: string | null;
};

export type ResolvedBookingTarget =
  | { kind: 'local'; appointmentId: string }
  | {
      kind: 'crm_only';
      crmRecordId: string;
      scheduledDate: string;
      scheduledTime: string;
      serviceNames?: string[];
      locationId?: string;
    }
  | {
      kind: 'ambiguous';
      candidates: Array<{ source: 'local' | 'crm'; label: string }>;
    }
  | { kind: 'none' };

function normalizeTime(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return '00:00';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** ISO / CRM date → DD.MM.YYYY for local Appointment fields. */
export function isoDateToUaDate(isoOrUa: string): string | null {
  const s = isoOrUa.trim();
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s;
  const iso = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function uaDateToIso(ua: string): string | null {
  const p = parseAgentDate(ua.trim());
  return p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null;
}

export function crmBookingToUaRow(b: CrmUpcomingBooking): UpcomingVisitRow | null {
  const ua = isoDateToUaDate(b.date);
  if (!ua) return null;
  return {
    scheduledDate: ua,
    scheduledTime: normalizeTime(b.time),
    services: (b.serviceNames ?? []).map((name) => ({ name })),
  };
}

export function pickSingleUpcomingLocal(
  rows: LocalBookingCandidate[],
  now: Date,
  timeZone: string,
): LocalBookingCandidate | 'ambiguous' | null {
  const mapped: UpcomingVisitRow[] = rows
    .filter((r) => Boolean(parseAgentDate(r.scheduledDate)))
    .map((r) => ({
      scheduledDate: r.scheduledDate,
      scheduledTime: r.scheduledTime,
      services: [],
    }));
  const picked = selectUpcomingVisits(mapped, now, timeZone);
  if (picked.length === 0) return null;
  if (picked.length > 1) return 'ambiguous';
  const hit = picked[0]!;
  return (
    rows.find(
      (r) => r.scheduledDate === hit.scheduledDate && r.scheduledTime === hit.scheduledTime,
    ) ?? null
  );
}

export function pickSingleUpcomingCrm(
  rows: CrmUpcomingBooking[],
  now: Date,
  timeZone: string,
): CrmUpcomingBooking | 'ambiguous' | null {
  const withUa = rows
    .map((b) => {
      const ua = crmBookingToUaRow(b);
      return ua ? { booking: b, ua } : null;
    })
    .filter((x): x is { booking: CrmUpcomingBooking; ua: UpcomingVisitRow } => x != null);

  const picked = selectUpcomingVisits(
    withUa.map((x) => x.ua),
    now,
    timeZone,
  );
  if (picked.length === 0) return null;
  if (picked.length > 1) return 'ambiguous';
  const hit = withUa.find(
    (x) =>
      x.ua.scheduledDate === picked[0]!.scheduledDate &&
      x.ua.scheduledTime === picked[0]!.scheduledTime,
  );
  return hit?.booking ?? null;
}

/** Prefer conversation-local row; else sole upcoming for client; else sole CRM. */
export function resolveBookingTargetPreference(opts: {
  conversationLocal: LocalBookingCandidate | null;
  clientLocals: LocalBookingCandidate[];
  crmBookings: CrmUpcomingBooking[];
  now: Date;
  timeZone: string;
}): ResolvedBookingTarget {
  if (opts.conversationLocal) {
    return { kind: 'local', appointmentId: opts.conversationLocal.id };
  }

  const localPick = pickSingleUpcomingLocal(opts.clientLocals, opts.now, opts.timeZone);
  if (localPick === 'ambiguous') {
    return {
      kind: 'ambiguous',
      candidates: opts.clientLocals.map((r) => ({
        source: 'local' as const,
        label: `${r.scheduledDate} ${r.scheduledTime}`,
      })),
    };
  }
  if (localPick) {
    return { kind: 'local', appointmentId: localPick.id };
  }

  const crmPick = pickSingleUpcomingCrm(opts.crmBookings, opts.now, opts.timeZone);
  if (crmPick === 'ambiguous') {
    return {
      kind: 'ambiguous',
      candidates: opts.crmBookings.map((b) => {
        const ua = isoDateToUaDate(b.date) ?? b.date;
        return {
          source: 'crm' as const,
          label: `${ua} ${normalizeTime(b.time)}`,
        };
      }),
    };
  }
  if (crmPick) {
    const ua = isoDateToUaDate(crmPick.date);
    if (!ua) return { kind: 'none' };
    return {
      kind: 'crm_only',
      crmRecordId: crmPick.id,
      scheduledDate: ua,
      scheduledTime: normalizeTime(crmPick.time),
      serviceNames: crmPick.serviceNames,
      locationId: crmPick.locationId,
    };
  }

  return { kind: 'none' };
}

export function isoRangeForUpcomingHorizon(
  now: Date,
  timeZone: string,
  horizonDays: number,
): { fromIsoDate: string; toIsoDate: string } {
  const z = getZonedDateTimeParts(now, timeZone);
  const fromIsoDate = `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
  const startKey = todayUaDateSortKey(now, timeZone);
  // Walk forward horizonDays in UTC calendar approximation (same as upcoming-visit).
  const y = Math.floor(startKey / 10000);
  const m = Math.floor((startKey % 10000) / 100);
  const d = startKey % 100;
  const end = new Date(Date.UTC(y, m - 1, d + horizonDays));
  const toIsoDate = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
  return { fromIsoDate, toIsoDate };
}

export function formatAmbiguousBookingToolResult(
  tool: string,
  candidates: Array<{ source: string; label: string }>,
): string {
  const list = candidates
    .slice(0, 6)
    .map((c) => `- ${c.label}`)
    .join('\n');
  return (
    `[${tool}] failed: кілька активних записів — уточни дату/час або request_handoff.\n` +
    list
  );
}
