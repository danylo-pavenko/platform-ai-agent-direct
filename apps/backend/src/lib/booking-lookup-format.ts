/**
 * Pure booking lookup helpers (no CRM / env side effects — safe for unit tests).
 */

import { normalizeToUaDate, parseAgentDate } from '../services/crm/beautypro-free-time.js';

const SERVICE_KEYWORDS = [
  'манікюр',
  'педикюр',
  'чистка',
  'покриття',
  'гель',
  'брів',
  'брови',
  'вії',
  'ламінування',
  'подолог',
  'волосся',
  'стрижка',
  'фарбування',
  'корекція',
  'зняття',
  'японськ',
] as const;

/** Shorter / keyword fallbacks when a long client phrase returns 0 CRM hits. */
export function broadenServiceQueries(query: string): string[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const out: string[] = [];
  const seen = new Set<string>([q]);

  const push = (s: string) => {
    const t = s.trim().toLowerCase();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const kw of SERVICE_KEYWORDS) {
    if (q.includes(kw)) push(kw);
  }

  const stripped = q
    .replace(/\b(чоловіч\w*|жіноч\w*|без\s+покриття|з\s+покриттям|звичайн\w*|прост\w*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped) push(stripped);

  return out;
}

export function formatSearchServicesToolResult(params: {
  query: string;
  matchCount: number;
  contextBlock: string;
  usedQuery: string;
  broadenedFrom?: string;
}): string {
  const { query, matchCount, contextBlock, usedQuery, broadenedFrom } = params;
  if (matchCount > 0) {
    if (broadenedFrom && usedQuery !== broadenedFrom) {
      return (
        `[search_services] За «${broadenedFrom}» точних збігів не було; знайдено за «${usedQuery}»:\n` +
        `${contextBlock}\n\n` +
        `Якщо клієнт просив дату/час — одразу виклич get_available_slots з service id + duration_min з цього результату.`
      );
    }
    return (
      `[search_services] РЕЗУЛЬТАТ:\n${contextBlock}\n\n` +
      `Якщо клієнт просив дату/час — одразу виклич get_available_slots з service id + duration_min з цього результату.`
    );
  }
  return (
    `[search_services] Нічого не знайдено за «${query}». ` +
    `НЕ вигадуй назву послуги, ціну чи тривалість. ` +
    `Виклич search_services ще раз з коротшим запитом (напр. «манікюр», «чистка», «педикюр») ` +
    `АБО request_handoff. Поки немає id послуги — get_available_slots не викликай.`
  );
}

export type ParsedSlotsArgs = {
  date: string;
  services: Array<{ id: string; durationMin: number }>;
  fullMonth: boolean;
  masterId?: string;
};

export function parseGetAvailableSlotsArgs(
  args: Record<string, unknown>,
): ParsedSlotsArgs | { error: string } {
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  const rawServices = Array.isArray(args.services) ? args.services : [];
  const services = rawServices.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const o = raw as Record<string, unknown>;
    const id =
      typeof o.id === 'string'
        ? o.id.trim()
        : typeof o.id === 'number' && Number.isFinite(o.id)
          ? String(o.id)
          : '';
    const durationMin =
      typeof o.duration_min === 'number' ? o.duration_min : Number(o.duration_min) || 60;
    if (!id) return [];
    return [{ id, durationMin }];
  });

  if (!date || services.length === 0) {
    return { error: '[get_available_slots] ПОМИЛКА: потрібні date та services (id + duration_min)' };
  }

  const normalizedDate = normalizeToUaDate(date);
  if (!parseAgentDate(normalizedDate)) {
    return {
      error:
        '[get_available_slots] ПОМИЛКА: дата має бути ДД.ММ.РРРР (напр. 08.08.2026)',
    };
  }

  const masterIdRaw = args.master_id;
  const masterId =
    typeof masterIdRaw === 'string'
      ? masterIdRaw.trim()
      : typeof masterIdRaw === 'number' && Number.isFinite(masterIdRaw)
        ? String(masterIdRaw)
        : undefined;

  return {
    date: normalizedDate,
    services,
    fullMonth: args.full_month === true,
    masterId: masterId || undefined,
  };
}
