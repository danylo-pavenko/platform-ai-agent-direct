/**
 * Detects customer-facing “your visit is cancelled” claims when
 * cancel_appointment did not return ok in the same turn.
 */

const CANCEL_CONFIRM_RE =
  /скасован[оаи]|скасову(ю|ємо|ємо)|скасували|переда(ла|ю|ли)\s+(запит\s+)?на\s+скасуван|вже\s+скасован|запис\s+скасован|візит\s+скасован|скасування\s+(вашого|вже|передано|опрацьов)/iu;

export function looksLikeCancelConfirmation(text: string): boolean {
  return CANCEL_CONFIRM_RE.test(text.trim());
}

export function shouldSanitizeFalseCancelConfirm(opts: {
  responseText: string;
  cancelToolOk: boolean;
  cancelToolCalled: boolean;
}): boolean {
  if (!opts.cancelToolCalled) return false;
  if (opts.cancelToolOk) return false;
  return looksLikeCancelConfirmation(opts.responseText);
}

export function sanitizeFalseCancelConfirmReply(originalText: string): string {
  const parts = originalText
    .split(/(?<=[.!?…🩷🌸🙏💕])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kept = parts.filter((s) => !CANCEL_CONFIRM_RE.test(s));
  const facts = kept.join(' ').trim();
  const suffix =
    'Запис ще не скасовано в системі — передаю адміністратору, щоб точно зняли візит у CRM. Дякуємо, що попередили 🙏';

  if (facts && !CANCEL_CONFIRM_RE.test(facts)) {
    return `${facts}\n\n${suffix}`;
  }
  return suffix;
}
