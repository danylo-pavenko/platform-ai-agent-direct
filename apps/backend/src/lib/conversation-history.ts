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

/**
 * Build Claude conversation history without duplicating the current user turn.
 *
 * The webhook persists the inbound message before calling the agent, so the
 * latest row often matches `currentUserText` — exclude it from history and
 * keep it only in `userMessage` (saves tokens, Phase 4).
 */
export function buildClaudeHistoryTurns(
  messagesAsc: HistoryMessageRow[],
  currentUserText: string,
  options?: { excludeIgMessageId?: string | null },
): ClaudeHistoryTurn[] {
  const current = currentUserText.trim();
  const excludeMid = options?.excludeIgMessageId?.trim() || null;

  let rows = messagesAsc.filter(
    (m) => m.direction !== 'system' && typeof m.text === 'string' && m.text.trim().length > 0,
  );

  if (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    const lastText = last.text!.trim();
    const matchesCurrent = current.length > 0 && lastText === current;
    const matchesMid =
      excludeMid && last.igMessageId && last.igMessageId === excludeMid;

    if (last.direction === 'in' && (matchesCurrent || matchesMid)) {
      rows = rows.slice(0, -1);
    }
  }

  return rows.map((m) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.text!.trim(),
  }));
}
