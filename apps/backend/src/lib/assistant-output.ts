/**
 * Customer-facing reply contract for Instagram / Telegram / sandbox.
 *
 * Layered defenses (prefer fixing causes upstream):
 * 1. Claude spawn cwd outside tenant_knowledge (no parent CLAUDE.md walk)
 * 2. Mode-scoped tool instructions in the prompt
 * 3. Anti-injection preamble in prompt-builder
 * 4. This gate — last mile: redact internal IDs, strip meta/JSON rants;
 *    replace with safe fallback only when nothing customer-facing remains.
 *    Prices and human-readable copy pass through.
 *    Never wipe replies that still have enough Cyrillic (UA client copy).
 */

const META_MARKERS_RE =
  /not a coding task|I should respond|respond in character|per the system prompt|This is an Instagram DM|Instagram DM from a customer|Looking at (?:the|this) (?:message|prompt)|Let me (?:just )?(?:respond|reply)|I'll (?:respond|reply) (?:as|in)|I'm going to (?:respond|reply)|The (?:user|customer) (?:is asking|asked|wants)|As (?:an? )?(?:AI|assistant|sales agent)|CLAUDE\.md|toolset|tools provided|doesn't match|does not match|knowledge base|business identity|entirely different compan|lead-?gen tools|e-commerce sales-?mode|mismatch between|wrong tools|orientation file/i;

const CYRILLIC_RE = /[\u0400-\u04FF]/;
const CYRILLIC_GLOBAL_RE = /[\u0400-\u04FF]/g;
const LATIN_GLOBAL_RE = /[A-Za-z]/g;

/** Keep / rescue client copy when at least this many Cyrillic letters remain. */
const MIN_CYRILLIC_CLIENT_COPY = 8;

const INTERNAL_XML_RE =
  /<\/?(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)[^>]*>[\s\S]*?<\/(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)>/gi;

const INTERNAL_XML_OPEN_ONLY_RE =
  /<\/?(?:thinking|thought|reflection|reasoning|scratchpad|analysis|plan|antthinking)[^>]*>/gi;

/**
 * Neutral copy when the model produced only internal/meta text.
 * Do NOT promise a live manager — this is not a handoff.
 */
export const CUSTOMER_SAFE_META_FALLBACK =
  'Уточніть, будь ласка, ще раз — зараз підберу варіанти.';

export type CustomerFacingGateReason =
  | 'ok'
  | 'empty_after_sanitize'
  | 'meta_only';

export interface CustomerFacingGateResult {
  /** Text safe to send to the customer (never empty when ok/replaced). */
  text: string;
  /** True when original model text was rejected and replaced. */
  rejected: boolean;
  reason: CustomerFacingGateReason;
  /** True when internal IDs were scrubbed but the reply was still sent. */
  redactedInternals: boolean;
}

function latinCount(s: string): number {
  return (s.match(LATIN_GLOBAL_RE) ?? []).length;
}

function cyrillicCount(s: string): number {
  return (s.match(CYRILLIC_GLOBAL_RE) ?? []).length;
}

/** True when a chunk looks like internal English reasoning, not client copy. */
export function looksLikeAssistantMetaReasoning(chunk: string): boolean {
  const t = chunk.trim();
  if (!t) return false;
  if (META_MARKERS_RE.test(t)) return true;

  const lat = latinCount(t);
  const cyr = cyrillicCount(t);
  if (lat >= 40 && cyr < MIN_CYRILLIC_CLIENT_COPY && /\b(I should|I'll|I will|Let me|This is|There's|There is|I'm)\b/i.test(t)) {
    return true;
  }
  if (lat >= 120 && cyr < 12 && t.length >= 200) {
    return true;
  }
  return false;
}

/**
 * Remove leading English meta-reasoning so only the client-facing reply remains.
 * Never wipe a chunk that still has enough Cyrillic (UA client copy).
 */
export function stripAssistantMetaReasoning(text: string): string {
  let s = text.replace(/^\uFEFF/, '').trim();
  if (!s) return s;

  const cyrIdx = s.search(CYRILLIC_RE);
  if (cyrIdx > 0) {
    const before = s.slice(0, cyrIdx).trim();
    // Only strip a clear English meta preamble (not a short accidental marker).
    if (
      before.length >= 24 &&
      latinCount(before) >= 20 &&
      (looksLikeAssistantMetaReasoning(before) || META_MARKERS_RE.test(before))
    ) {
      s = s.slice(cyrIdx).trim();
    }
  }

  const parts = s.split(/\n\n+/);
  while (parts.length > 0 && looksLikeAssistantMetaReasoning(parts[0]!)) {
    if (cyrillicCount(parts[0]!) >= MIN_CYRILLIC_CLIENT_COPY) break;
    parts.shift();
  }
  s = parts.join('\n\n').trim();

  if (!s) return '';

  // Do not empty mixed/UA replies even if a meta marker also matched.
  if (cyrillicCount(s) >= MIN_CYRILLIC_CLIENT_COPY) {
    return s;
  }

  if (looksLikeAssistantMetaReasoning(s)) {
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
 * Light scrub for UA rescue: drop thinking XML only (keep Cyrillic even if
 * aggressive meta/fence stripping would have emptied the full sanitize path).
 */
function lightCleanKeepCyrillic(text: string): string {
  return collapseBlankLines(stripInternalXmlBlocks(text.replace(/^\uFEFF/, '')));
}

/**
 * Scrub artifacts from model text. May return empty when nothing customer-facing remains.
 * Preserves any result that still has enough Cyrillic.
 */
export function sanitizeCustomerFacingReply(text: string): string {
  let s = text.replace(/^\uFEFF/, '');
  s = stripInternalXmlBlocks(s);
  s = stripMarkdownCodeFences(s);
  s = stripStandaloneJsonArtifacts(s);
  s = stripAssistantMetaReasoning(s);
  s = collapseBlankLines(s);
  if (!s && cyrillicCount(text) >= MIN_CYRILLIC_CLIENT_COPY) {
    const rescued = lightCleanKeepCyrillic(text);
    if (cyrillicCount(rescued) >= MIN_CYRILLIC_CLIENT_COPY) return rescued;
  }
  return s;
}

/** Field names that must never reach the customer. Prices / amounts are allowed. */
const INTERNAL_ID_FIELD =
  'product_id|offer_id|service_id|master_id|crmBuyerId|crm_buyer_id|crm_external_id';

/**
 * Scrub leaked internal IDs from customer-facing text.
 * Does NOT touch prices, durations, or human-readable names — only id keys/values.
 */
export function redactLeakedInternalIds(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let s = text;

  const mark = (): string => {
    redacted = true;
    return '';
  };

  // Bracket form from CRM/tools: [master_id=abc-123], [product_id=9]
  s = s.replace(new RegExp(`\\[(?:${INTERNAL_ID_FIELD})\\s*=\\s*[^\\]]+\\]`, 'gi'), mark);
  // Key=value / key: value
  s = s.replace(new RegExp(`\\b(?:${INTERNAL_ID_FIELD})\\s*[=:]\\s*[\\w-]+`, 'gi'), mark);
  // Bare field name leftovers
  s = s.replace(new RegExp(`\\b(?:${INTERNAL_ID_FIELD})\\b`, 'gi'), mark);

  s = s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: s, redacted };
}

/**
 * Single outbound contract: scrub meta/JSON/IDs; replace only when nothing
 * customer-facing remains. Leaked IDs are redacted in-place (prices pass).
 * Callers should send `result.text` and treat `rejected` as output_validation.
 */
export function gateCustomerFacingReply(raw: string): CustomerFacingGateResult {
  const { text: withoutIds, redacted } = redactLeakedInternalIds(raw);
  const scrubbed = sanitizeCustomerFacingReply(withoutIds);

  if (scrubbed.trim()) {
    return {
      text: scrubbed,
      rejected: false,
      reason: 'ok',
      redactedInternals: redacted,
    };
  }

  // Rescue: full sanitize emptied the string, but UA client copy is still present.
  const light = lightCleanKeepCyrillic(withoutIds);
  if (cyrillicCount(light) >= MIN_CYRILLIC_CLIENT_COPY) {
    return {
      text: light,
      rejected: false,
      reason: 'ok',
      redactedInternals: redacted,
    };
  }

  return {
    text: CUSTOMER_SAFE_META_FALLBACK,
    rejected: true,
    reason: looksLikeAssistantMetaReasoning(raw.trim()) ? 'meta_only' : 'empty_after_sanitize',
    redactedInternals: redacted,
  };
}
