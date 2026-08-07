/**
 * Client-intent helpers for booking service search:
 * - gendered phrases («чоловічий манікюр») when the model searches the wrong SKU
 * - recovery when the model claims «same service» without re-searching
 */

import type { CrmServiceItem } from '../services/crm/types.js';

const GENDERED_SERVICE_RES = [
  /(чоловіч\p{L}*\s+(?:манікюр|педикюр))/u,
  /((?:манікюр|педикюр)\s+чоловіч\p{L}*)/u,
  /(жіноч\p{L}*\s+(?:манікюр|педикюр))/u,
  /((?:манікюр|педикюр)\s+жіноч\p{L}*)/u,
] as const;

/** Extract «чоловічий манікюр» / word-order variants from the client message. */
export function extractGenderedServiceIntent(clientMessage: string): string | null {
  const t = clientMessage.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const re of GENDERED_SERVICE_RES) {
    const m = t.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** True when the client named a gendered service but the tool query dropped the gender stem. */
export function queryDropsClientGender(query: string, clientMessage: string): boolean {
  const intent = extractGenderedServiceIntent(clientMessage);
  if (!intent) return false;
  const stem = intent.match(/чоловіч|жіноч/)?.[0];
  if (!stem) return false;
  return !query.toLowerCase().includes(stem);
}

/**
 * Prefer the top hit from a client-intent ranking (e.g. «чоловічий манікюр»)
 * ahead of whatever the model queried («гігієнічна чистка…»).
 */
export function preferIntentFirst(
  agentItems: CrmServiceItem[],
  intentItems: CrmServiceItem[],
  limit: number,
): CrmServiceItem[] {
  if (intentItems.length === 0) return agentItems.slice(0, limit);
  const seen = new Set<string>();
  const out: CrmServiceItem[] = [];
  for (const item of [...intentItems, ...agentItems]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Client is correcting / re-asserting the service (not a first vague «хочу манікюр»).
 */
export function looksLikeServiceCorrection(clientMessage: string): boolean {
  const t = clientMessage.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;

  if (/не\s+те\b|не\s+гігієн|інш(а|у)\s+послуг|помилил/.test(t)) {
    return /(манікюр|педикюр|чистка|покритт|стрижк)/.test(t) || Boolean(extractGenderedServiceIntent(t));
  }

  if (/мені\s+треба\s+просто\b|просто\s+чоловіч|просто\s+жіноч/.test(t)) {
    return true;
  }

  const intent = extractGenderedServiceIntent(t);
  if (intent && /мені\s+треба\b/.test(t) && t.length <= 120) {
    return true;
  }

  return false;
}

/** Assistant insists the wrong SKU is the same as what the client asked for. */
export function looksLikeFalseServiceEquivalence(assistantText: string): boolean {
  return /це\s+(якраз\s+)?та\s+сама\s+послуга|це\s+той\s+самий\b|те\s+ж\s+саме\b/i.test(
    assistantText,
  );
}

export function buildServiceCorrectionNudge(clientMessage: string): string {
  const intent = extractGenderedServiceIntent(clientMessage);
  const qHint = intent ?? 'точними словами клієнта з останнього повідомлення';
  return (
    `[platform] Клієнт уточнює/виправляє послугу. Ти НЕ викликав search_services ` +
    `(або сказав «це та сама послуга» без нового пошуку). ` +
    `ОБОВ'ЯЗКОВО виклич search_services з query близьким до: «${qHint}». ` +
    `Обери позицію з найближчою назвою в РЕЗУЛЬТАТІ. ` +
    `Не стверджуй, що це та сама послуга, без нового пошуку.`
  );
}

export function formatClientIntentNote(intentQuery: string): string {
  return (
    `\n\n[platform] У клієнта є формулювання «${intentQuery}». ` +
    `Перші рядки вище пріоритезовані під цей намір. ` +
    `Не підміняй на гігієнічну чистку / інший комплекс, якщо в каталозі є відповідна позиція.`
  );
}
