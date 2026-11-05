/**
 * Detects customer-facing “already moved / transferring your visit” claims when
 * reschedule_appointment did not return ok in the same turn.
 *
 * After a failed mutation the model may rewrite once: honest reply, or SILENCE
 * (prefer silence over a canned platform apology).
 */

const RESCHEDULE_CONFIRM_RE =
  /перенес(ла|ли|у|ємо|ено)|переношу|переносимо|вже\s+перенес|запис\s+перенес|візит\s+перенес|переда(ла|ю|ли)\s+(запит\s+)?на\s+перенесен|підтвердження\s+надійде|заявку\s+вже\s+передала|система\s+(підтвердить|опрацює)|трохи\s+зачекайте\s+на\s+підтвердження/iu;

/** Model opts out of a customer bubble after a failed cancel/reschedule. */
const SILENCE_TOKEN_RE = /^\s*(?:\[?\s*SILENCE\s*\]?|МОВЧАННЯ|NO_REPLY)\s*$/iu;

export function looksLikeRescheduleConfirmation(text: string): boolean {
  return RESCHEDULE_CONFIRM_RE.test(text.trim());
}

export function shouldSanitizeFalseRescheduleConfirm(opts: {
  responseText: string;
  rescheduleToolCalled: boolean;
  rescheduleToolOk: boolean;
}): boolean {
  if (!opts.rescheduleToolCalled) return false;
  if (opts.rescheduleToolOk) return false;
  return looksLikeRescheduleConfirmation(opts.responseText);
}

/**
 * Strip false «перенесла» claims only — no canned handoff suffix.
 * Empty string = prefer silence until/unless the model rewrites consciously.
 */
export function sanitizeFalseRescheduleConfirmReply(originalText: string): string {
  const parts = originalText
    .split(/(?<=[.!?…🩷🌸🙏💕🙂])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kept = parts.filter((s) => !RESCHEDULE_CONFIRM_RE.test(s));
  return kept.join(' ').trim();
}

export function isAgentChosenSilence(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  return SILENCE_TOKEN_RE.test(t);
}

export type BookingMutationTool =
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'remove_appointment_service';

const BOOKING_MUTATION_TOOLS: readonly BookingMutationTool[] = [
  'reschedule_appointment',
  'cancel_appointment',
  'remove_appointment_service',
] as const;

/** Most recent cancel/reschedule/remove in this turn that did not return ok. */
export function findFailedBookingMutation(
  tools: Array<{ name: string; resultPreview: string }>,
): { tool: BookingMutationTool; toolResult: string } | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]!;
    if (!(BOOKING_MUTATION_TOOLS as readonly string[]).includes(t.name)) continue;
    const ok = new RegExp(`\\[${t.name}\\]\\s*ok\\b`, 'i').test(t.resultPreview);
    if (!ok) {
      return { tool: t.name as BookingMutationTool, toolResult: t.resultPreview };
    }
  }
  return null;
}

export function buildBookingMutationFailureAwareNudge(opts: {
  tool: BookingMutationTool;
  toolResult: string;
  managerForced?: boolean;
}): string {
  const toolLabel =
    opts.tool === 'reschedule_appointment'
      ? 'перенесення'
      : opts.tool === 'cancel_appointment'
        ? 'скасування'
        : 'зміни послуг';
  const managerBit = opts.managerForced
    ? 'Це хід після кнопки «Відповісти по суті» — клієнту вже обіцяли змістовну відповідь, але успіху tool немає. '
    : '';

  return (
    `[platform] Tool ${opts.tool} НЕ успішний (візит у CRM не змінено). Result:\n` +
    `${opts.toolResult.slice(0, 500)}\n\n` +
    `${managerBit}` +
    `Твій попередній текст клієнту міг обіцяти ${toolLabel} — це заборонено без ok. ` +
    `Зараз ОБЕРИ усвідомлено:\n` +
    `A) Коротко і чесно напиши клієнту лише якщо це реально допомагає (напр. вікно зайняте / потрібен телефон / передаєш адміністратору). Без «вже перенесла / підтвердження надійде».\n` +
    `B) Якщо краще нічого не писати (менеджер поруч, порожня відповідь лише плутає, клієнт уже в очікуванні адміна) — відповісь РІВНО одним токеном: SILENCE\n` +
    `Не викликай знову той самий ${opts.tool}, якщо result уже failed з тією ж причиною. Можна request_handoff лише якщо клієнту треба жива людина і ти обрала варіант A з поясненням.`
  );
}
