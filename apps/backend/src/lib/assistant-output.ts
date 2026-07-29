/**
 * Customer-facing reply contract for Instagram / Telegram / sandbox.
 *
 * Layered defenses (prefer fixing causes upstream):
 * 1. Claude spawn cwd outside tenant_knowledge (no parent CLAUDE.md walk)
 * 2. Mode-scoped tool instructions in the prompt
 * 3. Anti-injection preamble in prompt-builder
 * 4. This gate — last mile: never ship coding/meta/tool rants to customers
 */

const META_MARKERS_RE =
  /not a coding task|I should respond|respond in character|per the system prompt|This is an Instagram DM|Instagram DM from a customer|Looking at (?:the|this) (?:message|prompt)|Let me (?:just )?(?:respond|reply)|I'll (?:respond|reply) (?:as|in)|I'm going to (?:respond|reply)|The (?:user|customer) (?:is asking|asked|wants)|As (?:an? )?(?:AI|assistant|sales agent)|CLAUDE\.md|toolset|tools provided|doesn't match|does not match|knowledge base|business identity|entirely different compan|lead-?gen tools|e-commerce sales-?mode|mismatch between|wrong tools|orientation file/i;

const CYRILLIC_RE = /[\u0400-\u04FF]/;

const INTERNAL_XML_RE =
  /<\/?(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)[^>]*>[\s\S]*?<\/(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)>/gi;

const INTERNAL_XML_OPEN_ONLY_RE =
  /<\/?(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)[^>]*>/gi;

/** Safe Ukrainian copy when the model produced only internal/meta text. */
export const CUSTOMER_SAFE_META_FALLBACK =
  'Дякую за повідомлення! Менеджер уточнить деталі й відповість найближчим часом.';

export type CustomerFacingGateReason =
  | 'ok'
  | 'empty_after_sanitize'
  | 'meta_only'
  | 'leaked_internals';

export interface CustomerFacingGateResult {
  /** Text safe to send to the customer (never empty when ok/replaced). */
  text: string;
  /** True when original model text was rejected and replaced. */
  rejected: boolean;
  reason: CustomerFacingGateReason;
}

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
  if (lat >= 40 && cyr < 8 && /\b(I should|I'll|I will|Let me|This is|There's|There is|I'm)\b/i.test(t)) {
    return true;
  }
  if (lat >= 120 && cyr < 12 && t.length >= 200) {
    return true;
  }
  return false;
}

/**
 * Remove leading English meta-reasoning so only the client-facing reply remains.
 * If the *entire* reply is meta (no client copy left), returns empty string.
 */
export function stripAssistantMetaReasoning(text: string): string {
  let s = text.replace(/^\uFEFF/, '').trim();
  if (!s) return s;

  const cyrIdx = s.search(CYRILLIC_RE);
  if (cyrIdx > 0) {
    const before = s.slice(0, cyrIdx).trim();
    if (looksLikeAssistantMetaReasoning(before) || META_MARKERS_RE.test(before)) {
      s = s.slice(cyrIdx).trim();
    }
  }

  const parts = s.split(/\n\n+/);
  while (parts.length > 0 && looksLikeAssistantMetaReasoning(parts[0]!)) {
    if (cyrillicCount(parts[0]!) >= 8) break;
    parts.shift();
  }
  s = parts.join('\n\n').trim();

  if (!s) return '';

  if (looksLikeAssistantMetaReasoning(s) && cyrillicCount(s) < 8) {
    return '';
  }

  return s;
}

export function stripMarkdownCodeFences(text: string): string {
  return text.replace(/```[\w+-]*\n?[\s\S]*?```/g, '').trim();
}

export function stripInternalXmlBlocks(text: string): string {
  return text
    .replace(INTERNAL_XML_RE, '')
    .replace(INTERNAL_XML_OPEN_ONLY_RE, '')
    .trim();
}

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
 * Scrub artifacts from model text. May return empty when nothing customer-facing remains.
 */
export function sanitizeCustomerFacingReply(text: string): string {
  let s = text.replace(/^\uFEFF/, '');
  s = stripInternalXmlBlocks(s);
  s = stripMarkdownCodeFences(s);
  s = stripStandaloneJsonArtifacts(s);
  s = stripAssistantMetaReasoning(s);
  return collapseBlankLines(s);
}

const LEAKED_INTERNALS_RE = /product_id|offer_id|purchased_price/i;

/**
 * Single outbound contract: scrub + reject meta-only / empty / leaked internals.
 * Callers should send `result.text` and treat `rejected` as output_validation.
 */
export function gateCustomerFacingReply(raw: string): CustomerFacingGateResult {
  if (LEAKED_INTERNALS_RE.test(raw)) {
    return {
      text: CUSTOMER_SAFE_META_FALLBACK,
      rejected: true,
      reason: 'leaked_internals',
    };
  }

  const scrubbed = sanitizeCustomerFacingReply(raw);
  if (!scrubbed.trim()) {
    return {
      text: CUSTOMER_SAFE_META_FALLBACK,
      rejected: true,
      reason: looksLikeAssistantMetaReasoning(raw.trim()) ? 'meta_only' : 'empty_after_sanitize',
    };
  }

  return { text: scrubbed, rejected: false, reason: 'ok' };
}
