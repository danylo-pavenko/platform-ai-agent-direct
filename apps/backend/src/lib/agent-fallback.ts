import { prisma } from './prisma.js';

/** Canned replies when Claude CLI is busy or times out (IG/TG customer channels). */
export const CUSTOMER_FALLBACK_BUSY =
  'Дякуємо за повідомлення! Менеджер відпише трохи пізніше.';

export const CUSTOMER_FALLBACK_TIMEOUT =
  'Одну хвилинку, менеджер відпише трохи пізніше.';

/**
 * Admin-only note persisted when a retry would re-send the same canned fallback.
 * Not sent to the customer; still counts as a non-real bot attempt for retry/handoff.
 */
export const AGENT_FALLBACK_RETRY_NOTE =
  '[agent_retry] Claude ще недоступний — клієнту вже надіслано очікування менеджера.';

export const AGENT_FALLBACK_RETRY_PREFIX = '[agent_retry]';

const FALLBACK_TEXTS = new Set([CUSTOMER_FALLBACK_BUSY, CUSTOMER_FALLBACK_TIMEOUT]);

/** How many fallback replies we send before auto-handoff on the next failure. */
export const AGENT_FALLBACK_MAX_BEFORE_HANDOFF = 5;

export function isSuppressedFallbackRetryNote(text: string): boolean {
  return text.trim().startsWith(AGENT_FALLBACK_RETRY_PREFIX);
}

/** Canned text that may be delivered to the customer (not the admin retry note). */
export function isCustomerVisibleFallbackReply(text: string): boolean {
  return FALLBACK_TEXTS.has(text.trim());
}

/**
 * True for canned customer fallbacks and suppressed retry notes —
 * neither counts as a "real" bot reply for conversation retry.
 */
export function isAgentFallbackReply(text: string): boolean {
  const t = text.trim();
  return FALLBACK_TEXTS.has(t) || isSuppressedFallbackRetryNote(t);
}

/**
 * Skip re-sending a canned fallback to the customer when this inbound
 * already got one (or a suppressed retry note). Retries may continue.
 */
export function shouldSuppressDuplicateCustomerFallback(opts: {
  candidateText: string;
  botOutboundsAfterInboundNewestFirst: string[];
}): boolean {
  if (!isCustomerVisibleFallbackReply(opts.candidateText)) return false;
  return opts.botOutboundsAfterInboundNewestFirst.some((t) => isAgentFallbackReply(t));
}

/** Count trailing bot messages that are agent fallbacks (newest first). */
export function countConsecutiveFallbacksFromNewest(botTextsNewestFirst: string[]): number {
  let count = 0;
  for (const text of botTextsNewestFirst) {
    if (!isAgentFallbackReply(text)) break;
    count++;
  }
  return count;
}

export async function countConsecutiveBotFallbacks(conversationId: string): Promise<number> {
  const recent = await prisma.message.findMany({
    where: { conversationId, sender: 'bot', direction: 'out' },
    orderBy: { createdAt: 'desc' },
    take: AGENT_FALLBACK_MAX_BEFORE_HANDOFF + 2,
    select: { text: true },
  });

  return countConsecutiveFallbacksFromNewest(
    recent.map((m) => m.text ?? ''),
  );
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
    return `Claude не зміг відповісти: ${tech}.${clientPart}${agentPart}`;
  }
  return `Claude не встиг відповісти за відведений час (таймаут CLI).${clientPart}${agentPart}`;
}
