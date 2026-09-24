/**
 * Upcoming local appointments for prompt injection (civil-day history may
 * hide yesterday’s booking talk — “I’m late” still needs visit context).
 */

import { parseAgentDate } from '../services/crm/beautypro-free-time.js';
import { getZonedDateTimeParts } from './tenant-timezone.js';
import { looksLikePlaceholderServiceName } from './service-display-name.js';

export type UpcomingVisitRow = {
  scheduledDate: string;
  scheduledTime: string;
  customerName?: string | null;
  services: unknown;
};

/** Sort key YYYYMMDD from DD.MM.YYYY (0 if unparseable). */
export function uaDateSortKey(date: string): number {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date.trim());
  if (!m) return 0;
  return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
}

export function todayUaDateSortKey(now: Date, timeZone: string): number {
  const z = getZonedDateTimeParts(now, timeZone);
  return z.year * 10000 + z.month * 100 + z.day;
}

function serviceLabelsFromJson(services: unknown): string[] {
  if (!Array.isArray(services)) return [];
  const out: string[] = [];
  for (const raw of services) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name && !looksLikePlaceholderServiceName(name, id)) out.push(name);
  }
  return out;
}

/**
 * Pick visits on/after today (tenant TZ), soonest first, capped.
 */
export function selectUpcomingVisits(
  rows: UpcomingVisitRow[],
  now: Date,
  timeZone: string,
  opts?: { horizonDays?: number; limit?: number },
): UpcomingVisitRow[] {
  const todayKey = todayUaDateSortKey(now, timeZone);
  const horizon = opts?.horizonDays ?? 3;
  const limit = opts?.limit ?? 3;

  return rows
    .filter((r) => Boolean(parseAgentDate(r.scheduledDate)))
    .map((r) => {
      const dayKey = uaDateSortKey(r.scheduledDate);
      return {
        row: r,
        dayDiff: civilDayDiffApprox(todayKey, dayKey),
        sort: dayKey * 10000 + timeToMinutes(r.scheduledTime),
      };
    })
    .filter((x) => x.dayDiff >= 0 && x.dayDiff <= horizon)
    .sort((a, b) => a.sort - b.sort)
    .slice(0, limit)
    .map((x) => x.row);
}

function timeToMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Difference in civil days between two YYYYMMDD keys (same/near months). */
function civilDayDiffApprox(fromKey: number, toKey: number): number {
  if (toKey < fromKey) return -1;
  const fy = Math.floor(fromKey / 10000);
  const fm = Math.floor((fromKey % 10000) / 100);
  const fd = fromKey % 100;
  const ty = Math.floor(toKey / 10000);
  const tm = Math.floor((toKey % 10000) / 100);
  const td = toKey % 100;
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
}

/** Prompt block for Claude — upcoming visit + lateness rule. */
export function formatUpcomingVisitsForPrompt(visits: UpcomingVisitRow[]): string {
  if (visits.length === 0) return '';

  const lines = visits.map((v) => {
    const labels = serviceLabelsFromJson(v.services);
    const svc = labels.length > 0 ? labels.join(', ') : 'послуга';
    return `- ${v.scheduledDate} о ${v.scheduledTime}: ${svc}`;
  });

  return [
    'Найближчі записи цього клієнта (локально / CRM mirror):',
    ...lines,
    'Якщо клієнт пише що запізнюється, вже в дорозі, «я тут», «через N хв» — це про НАЙБЛИЖЧИЙ візит вище, НЕ новий запис.',
    'Відповідай коротко й лояльно (напр. «Добре, чекаємо на Вас 😊»). Не пропонуй book_appointment і не кажи «підтвердіть дату й час».',
  ].join('\n');
}
