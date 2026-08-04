/**
 * Pure helpers for BeautyPro GET /employees/free_time.
 * Docs: https://aihelpssoft.github.io/documentations/ (employees/free_time)
 */

import type { CrmSlot, CrmSlotQuery } from './types.js';

export type FreeTimeResponse = Record<string, Record<string, string[]>>;

export type FreeTimeQueryOpts = {
  /**
   * When true, API returns only the nearest day with availability inside from..to.
   * For an agent-requested calendar day we want ALL slots that day → false.
   */
  nearestDayOnly?: boolean;
  /** When true, only employees with public=true. Omit to include all professionals. */
  publicEmployees?: boolean;
  /** When false, omit `services` filter (fallback if service/location pairing 400s). */
  includeServices?: boolean;
};

/** Agent dates are DD.MM.YYYY (CleverBOX style) or ISO YYYY-MM-DD. */
export function parseAgentDate(date: string): { y: number; m: number; d: number } | null {
  const trimmed = date.trim();
  const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (dmy) {
    return { d: Number(dmy[1]), m: Number(dmy[2]), y: Number(dmy[3]) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) {
    return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  }
  return null;
}

export function toIsoDate(parts: { y: number; m: number; d: number }): string {
  return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

export function freeTimeDayBounds(
  parts: { y: number; m: number; d: number },
  fullMonth: boolean,
): { from: string; to: string } {
  let from: Date;
  let to: Date;
  if (fullMonth) {
    from = new Date(Date.UTC(parts.y, parts.m - 1, 1, 0, 0, 0));
    to = new Date(Date.UTC(parts.y, parts.m, 0, 23, 59, 59));
  } else {
    from = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0));
    to = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 23, 59, 59));
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export function resolveFreeTimeDurationMin(
  services: Array<{ id: string; durationMin: number }>,
): number {
  const durations = services
    .map((s) => (Number.isFinite(s.durationMin) && s.durationMin > 0 ? s.durationMin : 60))
    .filter((n) => Number.isFinite(n));
  return Math.max(...(durations.length > 0 ? durations : [60]), 15);
}

/**
 * Build query params for GET /employees/free_time.
 * Specific calendar day → nearest_day_only=false (all slots that day).
 */
export function buildFreeTimeQueryParams(
  query: CrmSlotQuery,
  opts: FreeTimeQueryOpts = {},
): Record<string, string | number | boolean | undefined> {
  const parts = parseAgentDate(query.date);
  if (!parts) {
    throw new Error(`BeautyPro: invalid date "${query.date}" (use DD.MM.YYYY or YYYY-MM-DD)`);
  }

  const fullMonth = query.fullMonth === true;
  const { from, to } = freeTimeDayBounds(parts, fullMonth);
  const duration = resolveFreeTimeDurationMin(query.services);
  const nearestDayOnly = opts.nearestDayOnly ?? false;
  const includeServices = opts.includeServices !== false;

  const params: Record<string, string | number | boolean | undefined> = {
    from,
    to,
    duration,
    step: 'auto',
    location: query.branchId,
    add_now_time: 20,
    nearest_day_only: nearestDayOnly,
  };

  if (includeServices && query.services.length > 0) {
    params.services = query.services.map((s) => s.id).join(',');
  }

  if (opts.publicEmployees === true) {
    params.public_employees = true;
  } else if (opts.publicEmployees === false) {
    params.public_employees = false;
  }

  const masterId = query.masterId?.trim();
  if (masterId) {
    params.professionals = masterId;
  }

  return params;
}

/** Detect soft-error JSON bodies that some gateways return with HTTP 200. */
export function assertFreeTimePayload(raw: unknown): FreeTimeResponse {
  if (raw == null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `BeautyPro free_time: unexpected response type ${Array.isArray(raw) ? 'array' : typeof raw}`,
    );
  }

  const obj = raw as Record<string, unknown>;
  const softMsg =
    (typeof obj.message === 'string' && obj.message) ||
    (typeof obj.error === 'string' && obj.error) ||
    (typeof obj.Message === 'string' && obj.Message);
  const looksLikeError =
    softMsg &&
    (obj.code != null ||
      obj.status != null ||
      obj.error != null ||
      Object.keys(obj).every((k) =>
        /^(message|error|code|status|Message|Error)$/i.test(k),
      ));
  if (looksLikeError && softMsg) {
    throw new Error(`BeautyPro free_time: ${softMsg}`);
  }

  return obj as FreeTimeResponse;
}

export function invertFreeTime(
  free: FreeTimeResponse,
): { slots: Record<string, CrmSlot[]>; masterIds: Set<string> } {
  const slots: Record<string, CrmSlot[]> = {};
  const masterIds = new Set<string>();
  const byDateTime = new Map<string, Map<string, string[]>>();

  for (const [professionalId, days] of Object.entries(free ?? {})) {
    if (!days || typeof days !== 'object' || Array.isArray(days)) {
      continue;
    }
    masterIds.add(professionalId);
    for (const [day, times] of Object.entries(days)) {
      if (!Array.isArray(times)) continue;
      if (!byDateTime.has(day)) byDateTime.set(day, new Map());
      const dayMap = byDateTime.get(day)!;
      for (const time of times) {
        if (typeof time !== 'string' || !time.trim()) continue;
        const list = dayMap.get(time) ?? [];
        list.push(professionalId);
        dayMap.set(time, list);
      }
    }
  }

  for (const [day, timeMap] of byDateTime) {
    const daySlots: CrmSlot[] = [];
    for (const [time, masters] of [...timeMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      daySlots.push({ date: day, time, masterIds: masters });
    }
    slots[day] = daySlots;
  }

  return { slots, masterIds };
}
