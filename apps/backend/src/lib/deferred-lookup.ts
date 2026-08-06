/**
 * Detects customer-facing "I'll look it up / searching now" fillers that
 * promise a catalog/schedule answer without an actual tool call in the same turn.
 */

const PURE_STALL_RE =
  /шукаю\s+(точні\s+)?варіанти|шукаю\s+в\s+каталоз|зараз\s+буде\b|зараз\s+підтягну|зараз\s+знайду|одну\s+хвилинк.*(?:каталог|розклад|слот)|перевірю\s+каталог|подивлюсь\s+в\s+(?:каталоз|баз|crm)|перевірю\s+вільн|подивлюсь\s+вільн|вільн\w*\s+вікн/i;

const DEFERRED_LOOKUP_RE =
  /зараз\s+(ще\s+раз\s+)?(пошукаю|перевірю|подивлюсь|знайду)|зараз\s+ще\s+раз\s+перевірю/i;

const SLOTS_PROMISE_RE =
  /(?:зараз\s+)?(?:перевірю|подивлюсь|підтягну|знайду)\s+(?:вільн|розклад|слот)|вільн\w*\s+вікн|слоти\s+на\s+/i;

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

/** True when the reply promises free slots / schedule without delivering them. */
export function looksLikeDeferredSlotsPromise(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SLOTS_PROMISE_RE.test(t) && !/\d{1,2}:\d{2}/.test(t)) return true;
  if (/зараз\s+перевірю\s+вільн/i.test(t)) return true;
  return false;
}

export function buildDeferredLookupNudge(
  lookupTool: 'search_services' | 'search_catalog' | 'get_available_slots',
): string {
  if (lookupTool === 'get_available_slots') {
    return (
      `[platform] Ти написав клієнту, що перевіряєш вільні вікна/розклад, але НЕ викликав ` +
      `get_available_slots (або виклик не був виконаний). Заборонено обіцяти слоти без tool_call. ` +
      `Зараз ОБОВ'ЯЗКОВО: якщо вже є service id + duration_min з search_services — виклич ` +
      `get_available_slots на дату клієнта; якщо послуги ще немає — спочатку search_services, ` +
      `потім get_available_slots. У відповіді клієнту дай 2–3 конкретні вікна з іменами майстрів. ` +
      `Не вигадуй ціни/послуги. Не пиши знову «зараз перевірю».`
    );
  }
  const slotsHint =
    lookupTool === 'search_services'
      ? ' Якщо клієнт уже назвав дату — після пошуку одразу виклич get_available_slots.'
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
