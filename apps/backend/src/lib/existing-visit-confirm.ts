/**
 * Distinguish “confirm my existing visit” (admin reminder) from
 * “confirm the new slot you offered” (booking funnel).
 */

/** Manager/admin asked the client to confirm an already-booked visit. */
const VISIT_REMINDER_RE =
  /підтверд(іть|ити|жуйте|іть\s+будь\s+ласка).{0,80}візит|нагадуємо.{0,160}записан|ви\s+записан[іаия]?.{0,120}(?:о\s+\d{1,2}[:.]\d{2}|\d{1,2}[./]\d{1,2})|записан[іаия]?\s+до\s+нас.{0,80}підтверд/iu;

/** Short client reply that only confirms (not a new booking brief). */
const SHORT_VISIT_CONFIRM_RE =
  /^(підтверджую|підтверджуємо|так[,!]?\s*(підтверджую|буду)?|так\.?|буду\.?|буду\s*[!.]?|ок\.?|окей\.?|добре\.?|згодна?\.?|згоден\.?|підтверджую[,!]?\s*(візит|запис)?)\.?$/iu;

const SHORT_VISIT_CONFIRM_SOFT_RE =
  /^(так|добре|ок|окей)[,!]?\s*(підтверджую|буду|згодна?|згоден)\b/iu;

export function looksLikeVisitReminderText(text: string): boolean {
  return VISIT_REMINDER_RE.test(text.trim());
}

export function looksLikeShortVisitConfirmReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 100) return false;
  return SHORT_VISIT_CONFIRM_RE.test(t) || SHORT_VISIT_CONFIRM_SOFT_RE.test(t);
}

/**
 * True when the current client turn is acknowledging an existing visit
 * that a manager/bot just asked them to confirm.
 */
export function isExistingVisitConfirmTurn(opts: {
  clientMessage: string;
  recentOutboundTexts: string[];
}): boolean {
  if (!looksLikeShortVisitConfirmReply(opts.clientMessage)) return false;
  return opts.recentOutboundTexts.some((t) => looksLikeVisitReminderText(t));
}

/** Injected into the client profile block for this turn only. */
export function formatExistingVisitConfirmHint(opts?: {
  reminderSnippet?: string | null;
}): string {
  const snippet = opts?.reminderSnippet?.trim();
  const lines = [
    'Підтвердження існуючого візиту (нагадування адміністратора):',
    'Клієнт відповідає на нагадування про ВЖЕ створений запис («Підтвердіть візит» / «Ви записані…»).',
    'Це НЕ новий запис і НЕ вибір зі «Запропоновані вікна».',
    'Коротко подякуй і підтверди той самий день/час/майстра з нагадування або з «Найближчі записи».',
    'Заборонено: search_services, get_available_slots, book_appointment, reschedule_appointment.',
    'Якщо година з нагадування «зайнята» у слотах — це часто слот саме цього клієнта; не кажи що запис втрачено і не пропонуй інші вікна.',
  ];
  if (snippet) {
    lines.splice(2, 0, `Останнє нагадування: ${snippet.slice(0, 280)}`);
  }
  return lines.join('\n');
}
