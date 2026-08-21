/**
 * Detects customer-facing "you're booked / see you tomorrow" claims
 * without a matching book_appointment tool call in the same turn.
 */

const BOOKING_CONFIRM_RE =
  /чекаємо\s+(на\s+)?(тебе|вас)|чекаємо\s+(завтра|сьогодні|післязавтра)|будемо\s+чекати\s+(тебе|вас)|записую\s+(тебе|вас)|записала?\s+(тебе|вас)|записав\s+(тебе|вас)|записали\s+(вас|тебе)|ти\s+записан|вас\s+записан|ви\s+записан|запис\s+(підтверджено|створено|оформлено|готовий)|бачимось\s+(завтра|сьогодні|о\s+\d)|забронювала?\s+(тебе|вас|на\s+)|закріплю\s+за\s+вами/i;

/** Pure questions offering to book — not a false confirmation. */
const BOOKING_QUESTION_RE =
  /^(чи\s+)?(можемо|можна|хочеш|хочете|будеш|будете|давай|давайте|запишемо|записати)\b/i;

/**
 * True when the reply asserts the visit is already booked / waiting for the client.
 * Clarifying questions ("Можемо записати на завтра?") are allowed.
 */
export function looksLikeBookingConfirmation(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!BOOKING_CONFIRM_RE.test(t)) return false;

  // Whole message is a question without hard confirm verbs beyond "записати?"
  if (t.includes('?') && !/[.!…]/.test(t.replace(/\?/g, ''))) {
    if (BOOKING_QUESTION_RE.test(t) && !/чекаємо|записала|записав|бачимось|підтверджено|забронювала?/i.test(t)) {
      return false;
    }
  }

  return true;
}

export function buildFalseBookingConfirmNudge(): string {
  return (
    `[platform] Ти написав клієнту, що запис уже підтверджено («чекаємо тебе» / «записала» / «бачимось о HH:MM»), ` +
    `але НЕ викликав book_appointment у цій відповіді. Заборонено підтверджувати візит без <tool_call> book_appointment. ` +
    `Зараз: якщо вже є ПІБ, телефон, дата, час, послуги (id + duration_min) і філія на розмові — ОБОВʼЯЗКОВО виклич book_appointment. ` +
    `Якщо чогось бракує — НЕ стверджуй запис: залиш факти (ціна/тривалість) і коротко попроси відсутні дані або підтвердження слоту. ` +
    `Не пиши знову «чекаємо тебе / записала / бачимось».`
  );
}

/**
 * Strip booking-confirm sentences so we never send a false CRM confirmation.
 * Keeps price/service facts when present.
 */
export function sanitizeFalseBookingConfirmReply(originalText: string): string {
  const parts = originalText
    .split(/(?<=[.!?…💅])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kept = parts.filter((s) => !BOOKING_CONFIRM_RE.test(s));
  const facts = kept.join(' ').trim();
  const suffix =
    'Щоб забронювати цей час — підтвердь дату й час (і перевір телефон у профілі).';

  if (facts) {
    return `${facts}\n\n${suffix}`;
  }
  return suffix;
}
