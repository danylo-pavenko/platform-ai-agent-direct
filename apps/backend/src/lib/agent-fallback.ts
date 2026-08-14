import { prisma } from './prisma.js';
import {
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_BUSY_EN,
  CUSTOMER_FALLBACK_TIMEOUT,
  CUSTOMER_FALLBACK_TIMEOUT_EN,
} from './agent-fallback-defaults.js';
import {
  detectClientLanguage,
  normalizeClientLanguage,
  type ClientLanguage,
} from './client-language.js';

export {
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_BUSY_EN,
  CUSTOMER_FALLBACK_TIMEOUT,
  CUSTOMER_FALLBACK_TIMEOUT_EN,
} from './agent-fallback-defaults.js';

export { detectClientLanguage, normalizeClientLanguage };
export type { ClientLanguage };

export type FallbackLocaleMap = {
  uk: string;
  en: string;
};

export type FallbackMessages = {
  busy: FallbackLocaleMap;
  timeout: FallbackLocaleMap;
};

/**
 * Admin-only note persisted when a retry would re-send the same canned fallback.
 * Not sent to the customer; still counts as a non-real bot attempt for retry/handoff.
 */
export const AGENT_FALLBACK_RETRY_NOTE =
  '[agent_retry] Claude ще недоступний — клієнту вже надіслано очікування менеджера.';

export const AGENT_FALLBACK_RETRY_PREFIX = '[agent_retry]';

const DEFAULT_FALLBACK_TEXTS = new Set([
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_BUSY_EN,
  CUSTOMER_FALLBACK_TIMEOUT,
  CUSTOMER_FALLBACK_TIMEOUT_EN,
]);

/** How many fallback replies we send before auto-handoff on the next failure. */
export const AGENT_FALLBACK_MAX_BEFORE_HANDOFF = 5;

export type CustomerFallbackReason = 'busy' | 'timeout';

export function isSuppressedFallbackRetryNote(text: string): boolean {
  return text.trim().startsWith(AGENT_FALLBACK_RETRY_PREFIX);
}

/** All known customer-visible fallback strings (defaults + optional config). */
export function collectCustomerFallbackTexts(
  messages?: FallbackMessages | null,
): Set<string> {
  const set = new Set(DEFAULT_FALLBACK_TEXTS);
  if (messages) {
    for (const reason of ['busy', 'timeout'] as const) {
      for (const lang of ['uk', 'en'] as const) {
        const t = messages[reason][lang]?.trim();
        if (t) set.add(t);
      }
    }
  }
  return set;
}

/** Canned text that may be delivered to the customer (not the admin retry note). */
export function isCustomerVisibleFallbackReply(
  text: string,
  messages?: FallbackMessages | null,
): boolean {
  return collectCustomerFallbackTexts(messages).has(text.trim());
}

/**
 * True for canned customer fallbacks and suppressed retry notes —
 * neither counts as a "real" bot reply for conversation retry.
 */
export function isAgentFallbackReply(
  text: string,
  messages?: FallbackMessages | null,
): boolean {
  const t = text.trim();
  return collectCustomerFallbackTexts(messages).has(t) || isSuppressedFallbackRetryNote(t);
}

/**
 * Resolve localized customer fallback from agent_config (+ defaults).
 * Unknown / missing language → uk.
 */
export function resolveCustomerFallback(
  reason: CustomerFallbackReason,
  lang: ClientLanguage | string | null | undefined,
  messages: FallbackMessages,
): string {
  const locale: ClientLanguage = normalizeClientLanguage(lang) ?? 'uk';
  const text = messages[reason][locale]?.trim();
  if (text) return text;
  return messages[reason].uk;
}

/**
 * Skip re-sending a canned fallback to the customer when this inbound
 * already got one (or a suppressed retry note). Retries may continue.
 */
export function shouldSuppressDuplicateCustomerFallback(opts: {
  candidateText: string;
  botOutboundsAfterInboundNewestFirst: string[];
  messages?: FallbackMessages | null;
}): boolean {
  if (!isCustomerVisibleFallbackReply(opts.candidateText, opts.messages)) return false;
  return opts.botOutboundsAfterInboundNewestFirst.some((t) =>
    isAgentFallbackReply(t, opts.messages),
  );
}

/** Count trailing bot messages that are agent fallbacks (newest first) by text. */
export function countConsecutiveFallbacksFromNewest(botTextsNewestFirst: string[]): number {
  let count = 0;
  for (const text of botTextsNewestFirst) {
    if (!isAgentFallbackReply(text)) break;
    count++;
  }
  return count;
}

const AGENT_FALLBACK_CODES = new Set(['busy', 'timeout']);

/** Count trailing bot outs with busy/timeout botFailureCode (or retry note text). */
export function countConsecutiveFallbacksFromCodes(
  rowsNewestFirst: Array<{ botFailureCode: string | null; text: string | null }>,
): number {
  let count = 0;
  for (const row of rowsNewestFirst) {
    const code = row.botFailureCode?.trim() ?? '';
    if (AGENT_FALLBACK_CODES.has(code)) {
      count++;
      continue;
    }
    if (isSuppressedFallbackRetryNote(row.text ?? '')) {
      count++;
      continue;
    }
    // Legacy rows without botFailureCode but with canned text
    if (!code && isAgentFallbackReply(row.text ?? '')) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export async function countConsecutiveBotFallbacks(conversationId: string): Promise<number> {
  const recent = await prisma.message.findMany({
    where: { conversationId, sender: 'bot', direction: 'out' },
    orderBy: { createdAt: 'desc' },
    take: AGENT_FALLBACK_MAX_BEFORE_HANDOFF + 2,
    select: { text: true, botFailureCode: true },
  });

  return countConsecutiveFallbacksFromCodes(recent);
}

export function shouldHandoffAfterAgentFallback(priorConsecutiveFallbacks: number): boolean {
  return priorConsecutiveFallbacks >= AGENT_FALLBACK_MAX_BEFORE_HANDOFF;
}

export type BotFailureCode = 'busy' | 'timeout' | 'output_validation';

const AGENT_TEXT_PREVIEW_MAX = 500;

function previewAgentText(agentText?: string | null): string {
  if (!agentText?.trim()) return '';
  const t = agentText.trim().replace(/\s+/g, ' ');
  const sliced = t.length > AGENT_TEXT_PREVIEW_MAX ? `${t.slice(0, AGENT_TEXT_PREVIEW_MAX)}…` : t;
  return ` Текст агента: «${sliced}».`;
}

/** Ukrainian explanation for admin UI and structured logs. */
export function formatBotFailureDetail(params: {
  code: BotFailureCode;
  errorDetail?: string | null;
  clientMessage?: string | null;
  /** Raw agent output before the customer-facing gate (for admin diagnostics). */
  agentText?: string | null;
  /** Gate reason when code is output_validation. */
  gateReason?: string | null;
}): string {
  const { code, errorDetail, clientMessage, agentText, gateReason } = params;
  const clientPart =
    clientMessage && clientMessage.trim()
      ? ` Запит клієнта: «${clientMessage.trim().slice(0, 200)}».`
      : '';
  const agentPart = previewAgentText(agentText);

  if (code === 'busy') {
    const tech = errorDetail?.trim();
    const queueHint = tech ? ` (${tech})` : '';
    return `Агент перевантажений — занадто багато одночасних запитів до Claude.${queueHint}${clientPart}${agentPart}`;
  }

  if (code === 'output_validation') {
    const reason = (gateReason ?? errorDetail ?? '').trim();
    let base: string;
    if (reason === 'meta_only') {
      base =
        'Відповідь агента містила службові/мета-роздуми без клієнтського тексту і була замінена безпечним текстом.';
    } else if (reason === 'empty_after_sanitize') {
      base =
        'Після очистки відповідь агента стала порожньою і була замінена безпечним текстом.';
    } else {
      base = 'Відповідь агента не пройшла валідацію і була замінена безпечним текстом.';
    }
    return `${base}${clientPart}${agentPart}`;
  }

  const tech = errorDetail?.trim();
  if (tech) {
    if (/429|session limit|rate[_ ]?limit|hit your (session|weekly|usage) limit/i.test(tech)) {
      return (
        `Claude відхилив запит через session/usage limit (429), а не через таймаут CLI: ${tech}.` +
        ` Адмінські % у Налаштуваннях можуть бути з застарілого кешу ~/.claude.json.` +
        `${clientPart}${agentPart}`
      );
    }
    return `Claude не зміг відповісти: ${tech}.${clientPart}${agentPart}`;
  }
  return `Claude не встиг відповісти за відведений час (таймаут CLI).${clientPart}${agentPart}`;
}
