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

export function looksLikeBookingConfirmationTease(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return (
    /зараз\s+надішл|надішлю\s+підтверджен|оформлюю\s+ваш\s+запис|обробл(яю|ю)\s+ваш\s+запис|щойно\s+отримаю\s+підтверджен|зараз\s+підтверджу/i.test(
      t,
    ) && !/\d{1,2}:\d{2}/.test(t)
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

  if (clientMessage && !looksLikeBookingConfirmationTease(clientMessage)) {
    // Prefer model copy when it already includes concrete time details.
    if (/\d{1,2}:\d{2}/.test(clientMessage) && /запис|чекаємо|підтвердж/i.test(clientMessage)) {
      return clientMessage;
    }
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
