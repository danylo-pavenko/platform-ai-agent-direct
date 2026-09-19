import { formatZonedSessionClock } from './tenant-timezone.js';
import { isSessionGapPastFreshness } from './session-freshness.js';
import { civilSessionGapDays } from './claude-history-window.js';
import { isIgNativeEchoContext } from './ig-native-echo.js';

export interface HistoryMessageRow {
  direction: string;
  text: string | null;
  sender?: string;
  igMessageId?: string | null;
  createdAt?: Date | string;
  igContext?: unknown;
}

export interface ClaudeHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface BuildClaudeHistoryOptions {
  excludeIgMessageId?: string | null;
  excludeIgMessageIds?: string[] | null;
  /** When set with createdAt on rows, prefix each turn with local date + sender. */
  timeZone?: string;
  sessionFreshnessDays?: number;
}

function buildExcludeMidSet(options?: BuildClaudeHistoryOptions): Set<string> {
  const set = new Set<string>();
  const single = options?.excludeIgMessageId?.trim();
  if (single) set.add(single);
  for (const id of options?.excludeIgMessageIds ?? []) {
    const trimmed = id?.trim();
    if (trimmed) set.add(trimmed);
  }
  return set;
}

function asDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function historySenderLabel(row: HistoryMessageRow): string {
  if (row.sender === 'manager') {
    return isIgNativeEchoContext(row.igContext) ? 'менеджер Instagram' : 'менеджер';
  }
  if (row.sender === 'bot') return 'бот';
  if (row.sender === 'client') return 'клієнт';
  if (row.sender === 'system') return 'система';
  return row.direction === 'in' ? 'клієнт' : 'бот';
}

export function formatClaudeHistoryStamp(
  date: Date,
  sender: string | undefined,
  timeZone: string,
  direction?: string,
  igContext?: unknown,
): string {
  const clock = formatZonedSessionClock(date, timeZone);
  const who = historySenderLabel({ direction: direction ?? 'out', sender, text: '', igContext });
  return `[${clock.dateTime} ${who}]`;
}

/** Visible pause between two history stamps. Civil-day gaps (salon TZ), not rolling 24h. */
export function formatSessionGapNotice(
  from: Date,
  to: Date,
  timeZone: string,
  sessionFreshnessDays: number,
): string | null {
  const days = civilSessionGapDays(from, to, timeZone);
  if (days < 1) return null;
  const fromLabel = formatZonedSessionClock(from, timeZone).dateTime;
  if (isSessionGapPastFreshness(from, to, sessionFreshnessDays)) {
    return (
      `[Пауза ${days} дн. з ${fromLabel}. Це може бути нове звернення — не продовжуй старий конфлікт як поточний; ` +
      `якщо клієнт вітається або хоче нове замовлення, відповідай як на новий запит.]`
    );
  }
  return `[Новий календарний день салону (пауза ${days} дн. з ${fromLabel}).]`;
}

function selectClaudeHistoryRows(
  messagesAsc: HistoryMessageRow[],
  currentUserText: string,
  options?: BuildClaudeHistoryOptions,
): HistoryMessageRow[] {
  const current = currentUserText.trim();
  const excludeMids = buildExcludeMidSet(options);

  let rows = messagesAsc.filter(
    (m) => m.direction !== 'system' && typeof m.text === 'string' && m.text.trim().length > 0,
  );

  // Drop trailing inbound rows that belong to the current coalesced turn.
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.direction !== 'in') break;

    const lastText = last.text!.trim();
    const matchesCurrent = current.length > 0 && lastText === current;
    const matchesMid =
      last.igMessageId != null && excludeMids.has(last.igMessageId);

    if (matchesCurrent || matchesMid) {
      rows = rows.slice(0, -1);
      // Only strip a single text-match when no mid set (legacy single-message path).
      if (matchesCurrent && !matchesMid && excludeMids.size === 0) break;
      continue;
    }
    break;
  }

  return rows;
}

/**
 * Build Claude conversation history without duplicating the current user turn.
 *
 * The webhook persists the inbound message before calling the agent, so the
 * latest row(s) often match the coalesced `userMessage` — exclude them from
 * history and keep them only in `userMessage` (saves tokens, Phase 4).
 *
 * When `timeZone` is set, turns are stamped with tenant-local date/time and
 * sender (менеджер vs бот). Roles stay user/assistant so the model contract
 * does not change.
 */
export function buildClaudeHistoryTurns(
  messagesAsc: HistoryMessageRow[],
  currentUserText: string,
  options?: BuildClaudeHistoryOptions,
): ClaudeHistoryTurn[] {
  const rows = selectClaudeHistoryRows(messagesAsc, currentUserText, options);
  const timeZone = options?.timeZone?.trim() || '';
  const freshnessDays = options?.sessionFreshnessDays ?? 14;

  let prevAt: Date | null = null;
  return rows.map((m) => {
    let content = m.text!.trim();
    const at = asDate(m.createdAt);
    if (timeZone && at) {
      const stamp = formatClaudeHistoryStamp(at, m.sender, timeZone, m.direction, m.igContext);
      const gap = prevAt
        ? formatSessionGapNotice(prevAt, at, timeZone, freshnessDays)
        : null;
      content = gap ? `${gap}\n${stamp} ${content}` : `${stamp} ${content}`;
      prevAt = at;
    }
    return {
      role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content,
    };
  });
}
