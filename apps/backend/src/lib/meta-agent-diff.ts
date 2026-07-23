/**
 * Meta-agent diff parse (JSON primary, legacy БУЛО/СТАЛО fallback)
 * and fuzzy fragment apply against prompt content.
 */

export interface SuggestedDiff {
  before: string;
  after: string;
  summary: string;
  sectionId?: string;
}

export interface ParsedMetaAgentResponse {
  reply: string;
  diffs: SuggestedDiff[];
  format: 'json' | 'legacy' | 'none';
}

export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Map an index in whitespace-collapsed string back to the original string index.
 */
function mapCollapsedIndexToOriginal(original: string, collapsedIndex: number): number {
  if (collapsedIndex <= 0) return 0;
  let collapsed = 0;
  let i = 0;
  let inSpace = false;
  // Skip leading whitespace in original the same way normalize does
  while (i < original.length && /\s/.test(original[i])) i += 1;

  while (i < original.length && collapsed < collapsedIndex) {
    const ch = original[i];
    if (/\s/.test(ch)) {
      if (!inSpace) {
        collapsed += 1; // one space in collapsed form
        inSpace = true;
      }
      i += 1;
    } else {
      inSpace = false;
      collapsed += 1;
      i += 1;
    }
  }
  return i;
}

/**
 * Find `before` in `content`: exact first, then whitespace-normalized unique match.
 */
export function findFragmentRange(
  content: string,
  before: string,
): { start: number; end: number } | null {
  const needle = before.trim();
  if (!needle) return null;

  const exact = content.indexOf(needle);
  if (exact !== -1) {
    return { start: exact, end: exact + needle.length };
  }

  const normContent = normalizeForMatch(content);
  const normNeedle = normalizeForMatch(needle);
  if (!normNeedle) return null;

  const first = normContent.indexOf(normNeedle);
  if (first === -1) return null;
  const second = normContent.indexOf(normNeedle, first + 1);
  if (second !== -1) {
    // Ambiguous — refuse fuzzy apply to avoid wrong section
    return null;
  }

  const start = mapCollapsedIndexToOriginal(content, first);
  const end = mapCollapsedIndexToOriginal(content, first + normNeedle.length);
  if (start >= end || end > content.length) return null;
  return { start, end };
}

export function applyDiffToContent(
  content: string,
  diff: SuggestedDiff,
): { ok: true; content: string } | { ok: false; error: string } {
  const after = diff.after?.trim() ?? '';
  if (!after) {
    return { ok: false, error: 'New prompt content (after) is required' };
  }

  const before = (diff.before ?? '').trim();
  if (!before) {
    return { ok: true, content: `${content.trimEnd()}\n\n${after}` };
  }

  const range = findFragmentRange(content, before);
  if (!range) {
    return {
      ok: false,
      error:
        'Фрагмент "БУЛО" не знайдено в поточному промпті. Можливо промпт змінився. Спробуйте ще раз.',
    };
  }

  const next = content.slice(0, range.start) + after + content.slice(range.end);
  return { ok: true, content: next };
}

export function applyDiffsSequentially(
  content: string,
  diffs: SuggestedDiff[],
): { ok: true; content: string } | { ok: false; error: string; failedIndex: number } {
  let working = content;
  for (let i = 0; i < diffs.length; i++) {
    const result = applyDiffToContent(working, diffs[i]);
    if (!result.ok) {
      return { ok: false, error: result.error, failedIndex: i };
    }
    working = result.content;
  }
  return { ok: true, content: working };
}

/** Legacy БУЛО/СТАЛО parser (kept for fallback). */
export function parseLegacyDiffs(text: string): SuggestedDiff[] {
  const buloMarker = '--- БУЛО ---';
  const staloMarker = '--- СТАЛО ---';
  const results: SuggestedDiff[] = [];

  const buloPositions: number[] = [];
  let pos = 0;
  while (true) {
    const idx = text.indexOf(buloMarker, pos);
    if (idx === -1) break;
    buloPositions.push(idx);
    pos = idx + buloMarker.length;
  }

  for (let i = 0; i < buloPositions.length; i++) {
    const buloIdx = buloPositions[i];
    const staloIdx = text.indexOf(staloMarker, buloIdx);
    if (staloIdx === -1) break;

    const afterBuloMarker = buloIdx + buloMarker.length;
    const before = text.slice(afterBuloMarker, staloIdx).trim();

    const afterStaloMarker = staloIdx + staloMarker.length;
    const nextBuloIdx = buloPositions[i + 1] ?? -1;
    const textAfterStalo =
      nextBuloIdx !== -1
        ? text.slice(afterStaloMarker, nextBuloIdx)
        : text.slice(afterStaloMarker);
    const after = textAfterStalo.replace(/\s*ЗМІНА\s*\d*\s*:?\s*$/, '').trim();

    if (!before && !after) continue;

    const textBeforeBulo = text.slice(0, buloIdx);
    const allPoyas = textBeforeBulo.match(/ПОЯСНЕННЯ(?:\s*\d+)?:\s*(.+?)(?:\n|$)/gi);
    let summary = '';
    if (allPoyas && allPoyas.length > 0) {
      const lastPoyas = allPoyas[allPoyas.length - 1];
      const m = lastPoyas.match(/ПОЯСНЕННЯ(?:\s*\d+)?:\s*(.+)/i);
      if (m) summary = m[1].trim();
    }

    results.push({ before, after, summary });
  }

  return results;
}

function coerceDiff(raw: unknown): SuggestedDiff | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const after = typeof obj.after === 'string' ? obj.after : '';
  if (!after.trim()) return null;
  const before = typeof obj.before === 'string' ? obj.before : '';
  const summary =
    typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim()
      : 'Зміна через мета-агент';
  const sectionId = typeof obj.sectionId === 'string' ? obj.sectionId : undefined;
  return { before, after, summary, ...(sectionId ? { sectionId } : {}) };
}

function tryParseJsonPayload(text: string): { reply: string; diffs: SuggestedDiff[] } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);

  // Last resort: largest {...} block
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) {
    candidates.push(text.slice(brace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const reply =
        typeof parsed.reply === 'string'
          ? parsed.reply
          : typeof parsed.message === 'string'
            ? parsed.message
            : '';
      const rawDiffs = Array.isArray(parsed.diffs)
        ? parsed.diffs
        : Array.isArray(parsed.suggestedDiffs)
          ? parsed.suggestedDiffs
          : [];
      const diffs = rawDiffs
        .map(coerceDiff)
        .filter((d): d is SuggestedDiff => d !== null);
      if (reply || diffs.length > 0) {
        return { reply: reply || text.trim(), diffs };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Prefer structured JSON; fall back to legacy БУЛО/СТАЛО markers.
 */
export function parseMetaAgentResponse(text: string): ParsedMetaAgentResponse {
  const json = tryParseJsonPayload(text);
  if (json && (json.diffs.length > 0 || json.reply)) {
    // If JSON had reply but no diffs, still try legacy diffs from raw text
    if (json.diffs.length === 0) {
      const legacy = parseLegacyDiffs(text);
      if (legacy.length > 0) {
        return { reply: json.reply || text, diffs: legacy, format: 'legacy' };
      }
    }
    return {
      reply: json.reply || text,
      diffs: json.diffs,
      format: json.diffs.length > 0 || json.reply ? 'json' : 'none',
    };
  }

  const legacy = parseLegacyDiffs(text);
  if (legacy.length > 0) {
    return { reply: text, diffs: legacy, format: 'legacy' };
  }

  return { reply: text, diffs: [], format: 'none' };
}
