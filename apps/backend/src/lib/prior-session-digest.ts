/**
 * Compact digest of messages before the civil-day Claude history window.
 * Soft personalization / unfinished context — not a live transcript extension.
 */

import { civilSessionGapDays } from './claude-history-window.js';
import { formatZonedSessionClock } from './tenant-timezone.js';

export const PRIOR_DIGEST_MAX_MESSAGES = 12;
export const PRIOR_DIGEST_MAX_CHARS = 1800;
export const PRIOR_DIGEST_LINE_MAX = 160;

export type PriorDigestMessage = {
  direction: string;
  sender?: string | null;
  text: string | null;
  createdAt: Date;
};

function whoLabel(row: PriorDigestMessage): string {
  if (row.sender === 'manager') return 'менеджер';
  if (row.sender === 'bot' || row.direction === 'out') return 'бот';
  return 'клієнт';
}

function clipLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= PRIOR_DIGEST_LINE_MAX) return t;
  return `${t.slice(0, PRIOR_DIGEST_LINE_MAX - 1)}…`;
}

export function priorDigestAgeHeader(
  oldest: Date,
  newest: Date,
  now: Date,
  timeZone: string,
): string {
  const gapFromNow = civilSessionGapDays(newest, now, timeZone);
  const fromLabel = formatZonedSessionClock(oldest, timeZone).dateTime;
  const toLabel = formatZonedSessionClock(newest, timeZone).dateTime;
  if (gapFromNow <= 0) {
    return `Раніше сьогодні (до поточного вікна історії), ${fromLabel}–${toLabel}`;
  }
  if (gapFromNow === 1) {
    return `Вчора / попередня сесія (${fromLabel}–${toLabel})`;
  }
  if (gapFromNow < 30) {
    return `${gapFromNow} дн. тому (${fromLabel}–${toLabel})`;
  }
  return `Давно (${fromLabel}–${toLabel})`;
}

/**
 * Format prior messages (already filtered to before history window), oldest→newest.
 */
export function formatPriorSessionDigestForPrompt(
  messages: PriorDigestMessage[],
  now: Date,
  timeZone: string,
): string {
  const usable = messages
    .filter((m) => typeof m.text === 'string' && m.text.trim().length > 0)
    .slice(-PRIOR_DIGEST_MAX_MESSAGES);
  if (usable.length === 0) return '';

  const oldest = usable[0]!.createdAt;
  const newest = usable[usable.length - 1]!.createdAt;
  const header = priorDigestAgeHeader(oldest, newest, now, timeZone);

  const lines: string[] = [];
  let total = 0;
  for (const m of usable) {
    const line = `- ${whoLabel(m)}: ${clipLine(m.text!)}`;
    if (total + line.length + 1 > PRIOR_DIGEST_MAX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  if (lines.length === 0) return '';

  return [
    `Попередня переписка (дайджест — ${header}):`,
    ...lines,
    'Це МИНУЛЕ (може бути вчора або давно). Не продовжуй як поточний діалог і не перепитуй уже вирішене з дайджесту, якщо клієнт явно не починає нове.',
    'Якщо є блок «Незавершений запис» — пріоритет у нього (закрий funnel). Якщо клієнт вітається з новим запитом без звʼязку з минулим — відповідай як на нове.',
  ].join('\n');
}
