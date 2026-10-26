/**
 * Tenant calendar events — lifecycle, keyword match, prompt formatting.
 * Pure helpers (no Prisma) so unit tests stay free of DB.
 */

export const RECENT_ENDED_DAYS = 14;

export type TenantEventKind = 'casting' | 'promo' | 'hiring' | 'collab' | 'other';
export type TenantEventStatus = 'draft' | 'active' | 'paused' | 'archived';
export type TenantEventOnMatch = 'inform' | 'handoff' | 'continue_funnel';
export type TenantEventLifecycle = 'open' | 'scheduled' | 'expired' | 'hidden';

export interface TenantEventFields {
  id: string;
  title: string;
  kind: TenantEventKind;
  status: TenantEventStatus;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  openFrom: Date | null;
  openUntil: Date | null;
  summary: string;
  details: string;
  keywords: string[];
  agentInstructions: string;
  onMatch: TenantEventOnMatch;
  handoffReason: string | null;
  closedReplyHint: string | null;
  priority: number;
}

export function defaultOnMatchForKind(kind: TenantEventKind): TenantEventOnMatch {
  if (kind === 'hiring' || kind === 'collab') return 'handoff';
  if (kind === 'casting') return 'continue_funnel';
  return 'inform';
}

/** First sentence or truncated details for the compact calendar line. */
export function summaryFromDetails(details: string, maxLen = 160): string {
  const trimmed = details.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const sentence = trimmed.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? trimmed;
  if (sentence.length <= maxLen) return sentence;
  return `${sentence.slice(0, maxLen - 1).trimEnd()}…`;
}

export function resolveEventLifecycle(
  event: Pick<TenantEventFields, 'status' | 'openFrom' | 'openUntil'>,
  now: Date = new Date(),
): TenantEventLifecycle {
  if (event.status === 'draft' || event.status === 'paused' || event.status === 'archived') {
    return 'hidden';
  }
  // status === active
  if (event.openFrom && now < event.openFrom) return 'scheduled';
  if (event.openUntil && now > event.openUntil) return 'expired';
  return 'open';
}

/** Still useful for soft-match / «вже не актуально» after openUntil. */
export function isRecentlyEnded(
  event: Pick<TenantEventFields, 'status' | 'openUntil'>,
  now: Date = new Date(),
  recentDays = RECENT_ENDED_DAYS,
): boolean {
  if (event.status !== 'active' && event.status !== 'paused' && event.status !== 'archived') {
    return false;
  }
  if (!event.openUntil) return false;
  if (now <= event.openUntil) return false;
  const cutoff = new Date(event.openUntil.getTime() + recentDays * 24 * 60 * 60 * 1000);
  return now <= cutoff;
}

export function eventVisibleForAgent(
  event: Pick<TenantEventFields, 'status' | 'openFrom' | 'openUntil'>,
  now: Date = new Date(),
): boolean {
  const life = resolveEventLifecycle(event, now);
  if (life === 'open' || life === 'scheduled') return true;
  if (life === 'expired') return isRecentlyEnded(event, now);
  // paused/archived with recent openUntil still surface as «закрито»
  if (event.status === 'paused' || event.status === 'archived') {
    return isRecentlyEnded(event, now);
  }
  return false;
}

function normalizeMatchText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[ʼ'`]/g, "'")
    .replace(/[^\p{L}\p{N}\s+#]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Score keyword/title hit against client query (0 = no match). */
export function scoreEventMatch(
  event: Pick<TenantEventFields, 'title' | 'keywords' | 'summary'>,
  query: string,
): number {
  const q = normalizeMatchText(query);
  if (!q || q.length < 2) return 0;

  let score = 0;
  const title = normalizeMatchText(event.title);
  if (title && (q.includes(title) || title.includes(q))) score += 40;

  for (const raw of event.keywords) {
    const kw = normalizeMatchText(raw);
    if (!kw) continue;
    if (q.includes(kw) || kw.includes(q)) {
      score += kw.length >= 4 ? 30 : 18;
      continue;
    }
    // token overlap
    const qTokens = q.split(' ').filter((t) => t.length >= 3);
    const kwTokens = kw.split(' ').filter((t) => t.length >= 3);
    for (const qt of qTokens) {
      if (kwTokens.some((kt) => kt === qt || kt.includes(qt) || qt.includes(kt))) {
        score += 12;
      }
    }
  }

  const summary = normalizeMatchText(event.summary);
  if (summary) {
    const qTokens = q.split(' ').filter((t) => t.length >= 4);
    for (const qt of qTokens) {
      if (summary.includes(qt)) score += 6;
    }
  }

  return score;
}

export function matchEventsByQuery<T extends TenantEventFields>(
  events: T[],
  query: string,
  now: Date = new Date(),
  minScore = 12,
): Array<T & { matchScore: number; lifecycle: TenantEventLifecycle }> {
  const scored = events
    .filter((e) => eventVisibleForAgent(e, now))
    .map((e) => ({
      ...e,
      matchScore: scoreEventMatch(e, query),
      lifecycle: resolveEventLifecycle(
        e.status === 'paused' || e.status === 'archived'
          ? { ...e, status: 'active' as const } // treat closed as expired for copy
          : e,
        now,
      ),
    }))
    .filter((e) => e.matchScore >= minScore);

  // paused/archived that are recently ended → force lifecycle expired for agent
  for (const e of scored) {
    if (e.status === 'paused' || e.status === 'archived') {
      e.lifecycle = 'expired';
    }
  }

  scored.sort((a, b) => b.matchScore - a.matchScore || b.priority - a.priority);
  return scored;
}

function formatDateShort(d: Date | null | undefined, timeZone?: string): string {
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function lifecycleUk(life: TenantEventLifecycle): string {
  if (life === 'open') return 'відкрита';
  if (life === 'scheduled') return 'запланована';
  if (life === 'expired') return 'завершена';
  return 'прихована';
}

function kindUk(kind: TenantEventKind): string {
  switch (kind) {
    case 'casting':
      return 'кастинг';
    case 'promo':
      return 'акція/знижка';
    case 'hiring':
      return 'вакансія/найм';
    case 'collab':
      return 'співпраця';
    default:
      return 'подія компанії';
  }
}

export function formatEventLineForPrompt(
  event: TenantEventFields,
  lifecycle: TenantEventLifecycle,
  timeZone?: string,
): string {
  const eventRange =
    event.eventStartsAt || event.eventEndsAt
      ? `подія ${formatDateShort(event.eventStartsAt, timeZone)}–${formatDateShort(event.eventEndsAt, timeZone)}`
      : 'дата події не фіксована';
  const openRange = `відгуки ${formatDateShort(event.openFrom, timeZone)}→${
    event.openUntil ? formatDateShort(event.openUntil, timeZone) : 'безстроково'
  }`;
  const kws = event.keywords.length ? `; ключі: ${event.keywords.slice(0, 8).join(', ')}` : '';
  return `- [${event.id.slice(0, 8)}] ${event.title} (${kindUk(event.kind)}, ${lifecycleUk(lifecycle)}) — ${eventRange}; ${openRange}. ${event.summary}${kws}`;
}

/** Compact calendar for runtime prompt (open + scheduled + recently ended). */
export function formatTenantEventsForPrompt(
  events: TenantEventFields[],
  now: Date = new Date(),
  timeZone?: string,
): string {
  const openOrScheduled: string[] = [];
  const ended: string[] = [];

  const sorted = [...events].sort((a, b) => b.priority - a.priority);
  for (const e of sorted) {
    if (!eventVisibleForAgent(e, now)) continue;
    let life = resolveEventLifecycle(e, now);
    if (e.status === 'paused' || e.status === 'archived') life = 'expired';
    const line = formatEventLineForPrompt(e, life, timeZone);
    if (life === 'expired') ended.push(line);
    else openOrScheduled.push(line);
  }

  if (openOrScheduled.length === 0 && ended.length === 0) return '';

  const parts: string[] = [];
  if (openOrScheduled.length > 0) {
    parts.push(
      'Активні події студії (календар — кастинг/акції·знижки/вакансії/співпраця/події компанії):',
      ...openOrScheduled,
      'Якщо клієнт пише про подію з календаря — lookup_tenant_events для деталей; дотримуйся agentInstructions. open+handoff → request_handoff(show_to_client=true). Не вигадуй умови поза описом.',
    );
  }
  if (ended.length > 0) {
    parts.push(
      'Нещодавно завершені події (якщо клієнт питає про них — скажи що вже неактуально; не book/handoff як на живу вакансію):',
      ...ended,
    );
  }
  return parts.join('\n');
}

export function formatEventToolResult(
  event: TenantEventFields & { lifecycle: TenantEventLifecycle; matchScore?: number },
  timeZone?: string,
): string {
  const lines = [
    `id=${event.id}`,
    `title=${event.title}`,
    `kind=${event.kind}`,
    `lifecycle=${event.lifecycle}`,
    `onMatch=${event.onMatch}`,
    `event=${formatDateShort(event.eventStartsAt, timeZone)}–${formatDateShort(event.eventEndsAt, timeZone)}`,
    `open=${formatDateShort(event.openFrom, timeZone)}→${event.openUntil ? formatDateShort(event.openUntil, timeZone) : 'безстроково'}`,
    `summary=${event.summary}`,
    `details=${event.details}`,
    `agentInstructions=${event.agentInstructions}`,
  ];
  if (event.handoffReason) lines.push(`handoffReason=${event.handoffReason}`);
  if (event.closedReplyHint) lines.push(`closedReplyHint=${event.closedReplyHint}`);
  if (event.keywords.length) lines.push(`keywords=${event.keywords.join(', ')}`);
  if (event.lifecycle === 'expired') {
    lines.push(
      'ACTION: подія/вакансія вже не актуальна — скажи клієнту коротко; не оформлюй як живу заявку; за потреби запропонуй звичайний запис/послуги.',
    );
  } else if (event.lifecycle === 'scheduled') {
    lines.push(
      'ACTION: відгуки ще не відкриті — скажи коли стартує набір (openFrom / дати події); не приймай заявку завчасно.',
    );
  } else if (event.onMatch === 'handoff') {
    lines.push(
      'ACTION: у тій самій відповіді напиши ПОВНЕ клієнтське повідомлення за agentInstructions і виклич request_handoff з show_to_client=true (без прапорця клієнт отримає лише «зʼєдную»). reason — для менеджера в Telegram.',
    );
  } else if (event.onMatch === 'continue_funnel') {
    lines.push('ACTION: підхопи офер і продовжуй booking/lead funnel (slots/book або brief).');
  } else {
    lines.push('ACTION: відповідай за agentInstructions / details (акція, знижка, умови події).');
  }
  return lines.join('\n');
}

export function formatMatchedEventHint(
  event: TenantEventFields,
  lifecycle: TenantEventLifecycle,
): string {
  const base = `Ймовірна подія: «${event.title}» (${kindUk(event.kind)}, ${lifecycleUk(lifecycle)}, id ${event.id.slice(0, 8)}…). Підтвердь через lookup_tenant_events.`;
  if (lifecycle === 'expired') {
    return `${base} Подія вже завершена — скажи що неактуально${
      event.closedReplyHint ? ` (${event.closedReplyHint})` : ''
    }.`;
  }
  if (lifecycle === 'scheduled') {
    return `${base} Відгуки ще не відкриті.`;
  }
  const handoffHint =
    event.onMatch === 'handoff'
      ? '; request_handoff(show_to_client=true) + повний клієнтський текст'
      : '';
  return `${base} onMatch=${event.onMatch}${handoffHint}.`;
}
