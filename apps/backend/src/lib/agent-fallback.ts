import { prisma } from './prisma.js';

/** Canned replies when Claude CLI is busy or times out (IG/TG customer channels). */
export const CUSTOMER_FALLBACK_BUSY =
  'Дякуємо за повідомлення! Менеджер відпише трохи пізніше.';

export const CUSTOMER_FALLBACK_TIMEOUT =
  'Одну хвилинку, менеджер відпише трохи пізніше.';

const FALLBACK_TEXTS = new Set([CUSTOMER_FALLBACK_BUSY, CUSTOMER_FALLBACK_TIMEOUT]);

/** How many fallback replies we send before auto-handoff on the next failure. */
export const AGENT_FALLBACK_MAX_BEFORE_HANDOFF = 2;

export function isAgentFallbackReply(text: string): boolean {
  return FALLBACK_TEXTS.has(text.trim());
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
