/**
 * Strip Claude Code / coding-persona meta-reasoning that sometimes leaks
 * into the customer-facing reply (English “not a coding task…” preamble).
 */

const META_MARKERS_RE =
  /not a coding task|I should respond|respond in character|per the system prompt|This is an Instagram DM|Instagram DM from a customer|Looking at (?:the|this) (?:message|prompt)|Let me (?:just )?(?:respond|reply)|I'll (?:respond|reply) (?:as|in)|I'm going to (?:respond|reply)|The (?:user|customer) (?:is asking|asked|wants)|As (?:an? )?(?:AI|assistant|sales agent)/i;

const CYRILLIC_RE = /[\u0400-\u04FF]/;

function latinCount(s: string): number {
  return (s.match(/[A-Za-z]/g) ?? []).length;
}

function cyrillicCount(s: string): number {
  return (s.match(CYRILLIC_RE) ?? []).length;
}

/** True when a chunk looks like internal English reasoning, not client copy. */
export function looksLikeAssistantMetaReasoning(chunk: string): boolean {
  const t = chunk.trim();
  if (!t) return false;
  if (META_MARKERS_RE.test(t)) return true;

  const lat = latinCount(t);
  const cyr = cyrillicCount(t);
  // Mostly Latin + first-person narration typical of CoT leaks.
  if (lat >= 40 && cyr < 8 && /\b(I should|I'll|I will|Let me|This is)\b/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Remove leading English meta-reasoning so only the client-facing reply remains.
 * Handles both separate paragraphs and “English. Привіт!” same-block leaks.
 */
export function stripAssistantMetaReasoning(text: string): string {
  let s = text.replace(/^\uFEFF/, '').trim();
  if (!s) return s;

  // Drop leading paragraphs that are pure meta-reasoning.
  const parts = s.split(/\n\n+/);
  while (parts.length > 1 && looksLikeAssistantMetaReasoning(parts[0]!)) {
    parts.shift();
  }
  s = parts.join('\n\n').trim();

  // Same block: English preamble then Cyrillic customer reply.
  const cyrIdx = s.search(CYRILLIC_RE);
  if (cyrIdx > 0) {
    const before = s.slice(0, cyrIdx).trim();
    if (looksLikeAssistantMetaReasoning(before) || META_MARKERS_RE.test(before)) {
      s = s.slice(cyrIdx).trim();
    }
  }

  return s;
}
