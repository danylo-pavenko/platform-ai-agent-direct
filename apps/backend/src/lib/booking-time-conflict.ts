/**
 * Helpers for BeautyPro TIME_CONFLICT recovery copy (no I/O).
 */

/** Parallel: one service → one master line for book_appointment wiring. */
export function formatParallelServiceMasterLines(
  services: Array<{ id: string; name?: string; masterId?: string }>,
  masterMap: Map<string, string>,
): string[] {
  return services
    .filter((s) => s.masterId)
    .map((s) => {
      const name = masterMap.get(s.masterId!) ?? s.masterId!;
      const svc = s.name?.trim() || `service ${s.id.slice(0, 8)}`;
      return `- ${svc} → [master_id=${s.masterId}] ${name}`;
    });
}

export function normalizeSlotTimeKey(time: string): string {
  const t = time.trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return t;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** Drop the failed clock time from slot tool text lines (`- HH:MM | …`). */
export function excludeFailedTimeFromSlotLines(
  slotText: string,
  failedTime: string,
): string {
  const key = normalizeSlotTimeKey(failedTime);
  return slotText
    .split('\n')
    .filter((line) => {
      const m = /^-\s*(\d{1,2}:\d{2})/.exec(line.trim());
      if (!m) return true;
      return normalizeSlotTimeKey(m[1]!) !== key;
    })
    .join('\n')
    .trim();
}

export function formatTimeConflictToolResult(opts: {
  failedTime: string;
  failedDate: string;
  alternativesText: string;
}): string {
  const alts = opts.alternativesText.trim();
  return [
    `[book_appointment] TIME_CONFLICT: час ${opts.failedDate} ${opts.failedTime} зайнятий у CRM (перетин з іншим записом).`,
    'НЕ пиши клієнту «записали / чекаємо / підтверджено». Запропонуй інший час з альтернатив нижче (або новий get_available_slots).',
    '',
    alts || 'Альтернативних вікон зараз немає — виклич get_available_slots на інший день.',
  ].join('\n');
}

/** Short IG message when CRM rejected the slot (no second Claude turn). */
export function buildClientFacingTimeConflictReply(toolResult: string): string {
  const slotLines = toolResult
    .split('\n')
    .filter((line) => /^-\s*\d{1,2}:\d{2}/.test(line.trim()))
    .slice(0, 3)
    .map((line) => line.replace(/\s*\|\s*tools:.*$/, '').trim());
  const dayHeaders = toolResult
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.replace(/^##\s+/, '').trim());

  if (slotLines.length === 0) {
    return (
      'На жаль, цей час щойно зайнявся в розкладі 🙏 Підкажіть інший зручний день або годину — підберемо вільне вікно.'
    );
  }

  const dayHint = dayHeaders[0] ? ` (${dayHeaders[0]})` : '';
  return [
    `На жаль, цей час щойно зайнявся в розкладі 🙏 Ось інші варіанти${dayHint}:`,
    ...slotLines.map((l) => l.replace(/^-\s*/, '• ')),
    '',
    'Який із них Вам підходить?',
  ].join('\n');
}
