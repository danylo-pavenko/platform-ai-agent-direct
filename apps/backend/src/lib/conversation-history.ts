export interface HistoryMessageRow {
  direction: string;
  text: string | null;
  sender?: string;
  igMessageId?: string | null;
}

export interface ClaudeHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface BuildClaudeHistoryOptions {
  excludeIgMessageId?: string | null;
  excludeIgMessageIds?: string[] | null;
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

/**
 * Build Claude conversation history without duplicating the current user turn.
 *
 * The webhook persists the inbound message before calling the agent, so the
 * latest row(s) often match the coalesced `userMessage` — exclude them from
 * history and keep them only in `userMessage` (saves tokens, Phase 4).
 */
export function buildClaudeHistoryTurns(
  messagesAsc: HistoryMessageRow[],
  currentUserText: string,
  options?: BuildClaudeHistoryOptions,
): ClaudeHistoryTurn[] {
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

  return rows.map((m) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.text!.trim(),
  }));
}
