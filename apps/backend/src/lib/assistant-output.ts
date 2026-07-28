/**
 * Post-process Claude text before it reaches Instagram / sandbox clients.
 * Strips coding-persona CoT, fenced scripts/JSON, and other internal artifacts.
 */

const META_MARKERS_RE =
  /not a coding task|I should respond|respond in character|per the system prompt|This is an Instagram DM|Instagram DM from a customer|Looking at (?:the|this) (?:message|prompt)|Let me (?:just )?(?:respond|reply)|I'll (?:respond|reply) (?:as|in)|I'm going to (?:respond|reply)|The (?:user|customer) (?:is asking|asked|wants)|As (?:an? )?(?:AI|assistant|sales agent)/i;

const CYRILLIC_RE = /[\u0400-\u04FF]/;

/** XML-ish internal blocks the model sometimes emits. */
const INTERNAL_XML_RE =
  /<\/?(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)[^>]*>[\s\S]*?<\/(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)>/gi;

const INTERNAL_XML_OPEN_ONLY_RE =
  /<\/?(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)[^>]*>/gi;

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

  const parts = s.split(/\n\n+/);
  while (parts.length > 1 && looksLikeAssistantMetaReasoning(parts[0]!)) {
    parts.shift();
  }
  s = parts.join('\n\n').trim();

  const cyrIdx = s.search(CYRILLIC_RE);
  if (cyrIdx > 0) {
    const before = s.slice(0, cyrIdx).trim();
    if (looksLikeAssistantMetaReasoning(before) || META_MARKERS_RE.test(before)) {
      s = s.slice(cyrIdx).trim();
    }
  }

  return s;
}

/** Drop ```…``` fences (json/js/bash dumps, “thinking” blocks). */
export function stripMarkdownCodeFences(text: string): string {
  return text.replace(/```[\w+-]*\n?[\s\S]*?```/g, '').trim();
}

/** Drop <thinking>…</thinking> and similar internal XML wrappers. */
export function stripInternalXmlBlocks(text: string): string {
  return text
    .replace(INTERNAL_XML_RE, '')
    .replace(INTERNAL_XML_OPEN_ONLY_RE, '')
    .trim();
}

/**
 * Drop standalone JSON object/array dumps (whole message or whole paragraph).
 * Keeps normal prose that happens to mention {price} etc.
 */
export function stripStandaloneJsonArtifacts(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return '';
    } catch {
      /* not valid JSON — keep */
    }
  }

  const parts = text.split(/\n\n+/);
  const kept = parts.filter((part) => {
    const p = part.trim();
    if (!p) return false;
    if (
      (p.startsWith('{') && p.endsWith('}')) ||
      (p.startsWith('[') && p.endsWith(']'))
    ) {
      try {
        JSON.parse(p);
        return false;
      } catch {
        return true;
      }
    }
    // Single-line JSON-looking tool dumps
    if (/^\s*[\{\[]/.test(p) && /"\w+"\s*:/.test(p) && p.length > 40) {
      try {
        JSON.parse(p);
        return false;
      } catch {
        return true;
      }
    }
    return true;
  });

  return kept.join('\n\n').trim();
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Full customer-facing scrubber (our real post-hook before IG / sandbox send).
 * Claude Code Stop hooks cannot rewrite `-p` stdout — sanitize here instead.
 */
export function sanitizeCustomerFacingReply(text: string): string {
  let s = text.replace(/^\uFEFF/, '');
  s = stripInternalXmlBlocks(s);
  s = stripMarkdownCodeFences(s);
  s = stripStandaloneJsonArtifacts(s);
  s = stripAssistantMetaReasoning(s);
  return collapseBlankLines(s);
}
