/**
 * Detects customer-facing "I'll look it up / searching now" fillers that
 * promise a catalog/schedule answer without an actual tool call in the same turn.
 */

const PURE_STALL_RE =
  /шукаю\s+(точні\s+)?варіанти|шукаю\s+в\s+каталоз|зараз\s+буде\b|зараз\s+підтягну|зараз\s+знайду|одну\s+хвилинк.*(?:каталог|розклад|слот)|перевірю\s+каталог|подивлюсь\s+в\s+(?:каталоз|баз|crm)/i;

const DEFERRED_LOOKUP_RE =
  /зараз\s+(ще\s+раз\s+)?(пошукаю|перевірю|подивлюсь|знайду)|зараз\s+ще\s+раз\s+перевірю/i;

/**
 * True when the model promised a later catalog/schedule lookup instead of
 * calling search_services / search_catalog / get_available_slots.
 * Clarifying questions ("зараз перевірю… Покриття чи без?") are allowed.
 */
export function looksLikeDeferredLookupPromise(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (PURE_STALL_RE.test(t)) return true;
  if (DEFERRED_LOOKUP_RE.test(t) && !t.includes('?')) return true;
  return false;
}

export function buildDeferredLookupNudge(lookupTool: 'search_services' | 'search_catalog'): string {
  const slotsHint =
    lookupTool === 'search_services'
      ? ' Якщо клієнт уже назвав дату — також виклич get_available_slots.'
      : '';
  return (
    `[platform] Ти написав клієнту, що шукаєш/перевіряєш каталог або розклад, ` +
    `але НЕ викликав ${lookupTool} у цій відповіді. Заборонено відправляти ` +
    `«зараз пошукаю / перевірю / зараз буде» без <tool_call>. ` +
    `Зараз ОБОВ'ЯЗКОВО виклич ${lookupTool} з релевантним query з останнього повідомлення клієнта.` +
    slotsHint +
    ` Потім дай конкретну відповідь з ціною/варіантами. Не повторюй обіцянку «зараз пошукаю».`
  );
}
