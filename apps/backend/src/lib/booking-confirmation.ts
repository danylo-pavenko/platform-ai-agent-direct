/**
 * Customer-facing booking confirmation after CRM sync (no I/O).
 */

export function normalizeServiceStartTime(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m) return t;
  return `${m[1]!.padStart(2, '0')}:${m[2]}`;
}

/** Claude promised a later confirm / system processing — host must send the real one. */
export function looksLikeBookingConfirmationTease(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return /зараз\s+надішл|надішлю\s+(вам\s+)?(підтверджен|деталі)|оформлюю\s+ваш\s+запис|обробл(яю|ю)\s+ваш\s+запис|передано\s+в\s+обробку|щойно\s+(система\s+)?(підтверд|отримаю)|система\s+підтверд|зараз\s+підтверджу|бронюванн/i.test(
    t,
  );
}

/** Model already stated a firm booking (not a tease). */
export function looksLikeFirmBookingConfirmation(text: string): boolean {
  const t = text.trim();
  if (!t || looksLikeBookingConfirmationTease(t)) return false;
  return (
    /\d{1,2}:\d{2}/.test(t) &&
    /запис\s+підтвердж|підтверджено|чекаємо\s+(на\s+)?(вас|тебе)|бачимось|записала\s+вас|записали\s+вас/i.test(
      t,
    )
  );
}

export function buildBookingConfirmationText(params: {
  date: string;
  time: string;
  services: Array<{ name?: string; startTime?: string }>;
  /** Claude reply from the same turn — used only if it already states the booking. */
  clientMessage?: string | null;
}): string {
  const { date, time, services } = params;
  const clientMessage = params.clientMessage?.trim() ?? '';

  if (clientMessage && looksLikeFirmBookingConfirmation(clientMessage)) {
    return clientMessage;
  }

  const lines =
    services.length > 0
      ? services.map((s) => {
          const start = normalizeServiceStartTime(s.startTime) || time;
          const name = (s.name ?? '').trim() || 'Послуга';
          return `• ${name} — ${start}`;
        })
      : [`• візит — ${time}`];

  return [`Запис підтверджено на ${date}:`, ...lines, '', 'Чекаємо на вас!'].join('\n');
}
