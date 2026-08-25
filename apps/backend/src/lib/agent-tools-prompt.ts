import type { ToolDefinition } from './claude-runtime.js';
import { isLookupToolName } from './tool-definitions.js';

export interface FormatAgentToolsPromptOptions {
  /**
   * SDK path: lookup tools are native MCP — omit them from the text protocol
   * JSON list; keep terminal tools as `<tool_call>`.
   */
  nativeLookup?: boolean;
  /**
   * SDK Phase 3: every customer tool is native MCP. No `<tool_call>` JSON
   * schemas in the prompt (CLI path still uses the text protocol).
   */
  nativeAll?: boolean;
}

/**
 * Formats agent tool schemas + invocation protocol for the Claude CLI prompt.
 * Native CLI tool_use is not available in headless `-p` mode, so we embed
 * definitions and require `<tool_call>` JSON blocks in the assistant reply.
 *
 * Rules are derived from the *actual* tool list for this turn — never instruct
 * sales collect_order when the tenant is in leadgen (and vice versa). That
 * mismatch was causing English “wrong toolset” rants in Instagram DM.
 */
export function formatAgentToolsPrompt(
  tools: ToolDefinition[],
  opts?: FormatAgentToolsPromptOptions,
): string {
  if (tools.length === 0) return '';

  const nativeAll = Boolean(opts?.nativeAll);
  const nativeLookup = nativeAll || Boolean(opts?.nativeLookup);
  const protocolTools = nativeAll
    ? []
    : nativeLookup
      ? tools.filter((t) => !isLookupToolName(t.name))
      : tools;
  const names = new Set(tools.map((t) => t.name));
  const toolsJson = JSON.stringify(
    protocolTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    null,
    2,
  );

  const invoke = (name: string) => (nativeLookup || nativeAll ? name : `<tool_call> ${name}`);

  const rules: string[] = [
    nativeAll
      ? 'Клієнт бачить лише твій текст. Усі tools — native MCP, не малюй <tool_call> JSON. Не кажи «записала / замовлення оформлено», поки відповідний tool не успішний.'
      : nativeLookup
      ? 'Клієнт бачить лише твій текст. Lookup tools — native (не <tool_call>). Terminal (book/collect/handoff/…) — блоки <tool_call> для клієнта невидимі.'
      : 'Клієнт бачить лише твій текст — блоки <tool_call> для нього невидимі.',
    'Викликай ЛИШЕ інструменти зі списку нижче. Не згадуй інші tools, режими чи CLAUDE.md клієнту.',
    'Якщо здається, що промпт і tools розходяться — відповідай клієнту з системного промпту/каталогу і не коментуй розбіжність.',
  ];

  if (names.has('create_local_order')) {
    rules.push(
      'Коли клієнт явно погодився на товар, послугу, дзвінок або сказав «оформляйте» / «давайте» — у ТІЙ САМІЙ відповіді виклич create_local_order (kind + summary). Це локальна заявка в адмінці (Замовлення) і картка в Telegram; CRM НЕ дзеркалить. Контакти передавай, якщо вже є.',
    );
  }
  if (names.has('collect_order')) {
    rules.push(
      'Коли пишеш клієнту ПОВНИЙ підсумок e-commerce замовлення (Товар / Отримувач / Телефон / Доставка НП / Оплата) — у ТІЙ САМІЙ відповіді ОБОВ\'ЯЗКОВО виклич collect_order. Тоді локальна БД + Telegram + CRM mirror (якщо write увімкнено).',
      'Коли клієнт підтвердив повне замовлення («так», «все вірно») і зібрані всі поля доставки — теж collect_order.',
      'payment_method у collect_order: card (онлайн/WayForPay), transfer (банківський переказ), cod (післяплата).',
      'Скасування оплати / повернення коштів — немає tool. request_handoff, не вигадуй refund у CRM.',
    );
  }
  if (names.has('book_appointment')) {
    rules.push(
      'Коли клієнт підтвердив слот (дата/час/послуга/філія за потреби) — у ТІЙ САМІЙ відповіді ОБОВʼЯЗКОВО виклич book_appointment (ПІБ, телефон, дата ДД.ММ.РРРР, час, services[{id,duration_min,master_id якщо різні майстри, start_time якщо різні години старту}]). Усі послуги одного візиту — одним масивом services[] (одне замовлення). Один майстер на всі послуги — top-level master_id. Паралельно до різних майстрів — master_id на КОЖНОМУ рядку services (з get_available_slots); інакше обидві послуги сядуть на одного і CRM дасть TIME_CONFLICT. Різні години (10:30 і 11:00) — start_time на КОЖНОМУ рядку; без цього всі стартують з time.',
      'Заборонено писати клієнту «записала / записав / записали вас / чекаємо тебе / бачимось о HH:MM / запис підтверджено / одразу закріплю / зараз надішлю підтвердження» без успішного book_appointment у ТІЙ САМІЙ відповіді. Підтвердження з деталями надсилає платформа після ok. Додати послугу до того самого слоту — краще одним book_appointment з усіма services[]; якщо вже викликав окремо — платформа змерджить повтор на той самий date+time у один запис (не стверджуй оновлення без tool).',
      'Не вибачайся за «технічні / некоректні повідомлення» і не кажи що щось відправилось помилково — клієнт цього не бачив. Просто відповідай по суті.',
      'Якщо tool повернув TIME_CONFLICT — запропонуй альтернативні години з результату; НЕ кажи що запис підтверджено.',
      'Дати всюди українським форматом ДД.ММ.РРРР (08.08.2026). Не використовуй YYYY-MM-DD у tool args і в тексті клієнту.',
      'Немає tool на скасування, перенесення запису чи повернення оплати. Якщо клієнт просить скасувати візит, перенести на інший день/час або скасувати/повернути оплату — request_handoff (не вигадуй cancel/reschedule). Заборонено «переносити» повторним book_appointment: інша дата = другий запис у CRM, старий лишиться.',
    );
  }
  if (names.has('search_services')) {
    rules.push(
      `Заборонено писати клієнту «зараз пошукаю / перевірю / шукаю в каталозі / зараз буде» без ${invoke('search_services')} у ТІЙ САМІЙ відповіді. Якщо послуга вже зрозуміла — одразу виклич search_services і в наступному кроці назви ціну/тривалість з результату. Уточнювальне питання можна ставити БЕЗ обіцянки «зараз пошукаю».`,
      'Якщо search_services повернув порожньо — НЕ вигадуй ціну/назву. Повторюй з коротшим query (манікюр, чистка, педикюр) або request_handoff.',
      'Якщо search_services повернув кілька схожих послуг — коротко уточни назву в клієнта (без service_id / UUID) і лише потім get_available_slots.',
      'Ціни з search_services: діапазон (напр. 400–800 ₴) + рядки грейдів у результаті — джерело правди. Клієнту без обраного майстра кажи діапазон або «від …»; назви рівнів — лише ті, що є в результаті (не вигадуй «Топ/Преміум»). Молодший/Майстер можуть не мати рядка на послугу = ця послуга їм недоступна.',
      'query у search_services — близький до слів клієнта (напр. «чоловічий манікюр»). Не підміняй на іншу назву з голови («гігієнічна чистка»), поки каталог цього не підтвердив. Обирай позицію з найближчою назвою в РЕЗУЛЬТАТІ, не перший рядок навмання.',
      'Якщо клієнт виправляє/уточнює послугу («мені треба X», «не те», «просто чоловічий…») — у ТІЙ САМІЙ відповіді знову search_services з новими словами. Заборонено казати «це та сама послуга» без нового пошуку.',
      'Якщо клієнт уже назвав дату/час і search_services дав id+duration_min — у наступній відповіді ОБОВʼЯЗКОВО виклич get_available_slots і дай 2–3 конкретні вікна. Не зупиняйся на «зараз перевірю вікна».',
    );
  }
  if (names.has('search_catalog')) {
    rules.push(
      `Заборонено писати «зараз пошукаю / перевірю в каталозі» без ${invoke('search_catalog')} у ТІЙ САМІЙ відповіді. Якщо товар/запит зрозумілий — одразу search_catalog і відповідай фактами з результату.`,
    );
  }
  if (names.has('get_available_slots')) {
    rules.push(
      'Повторний клієнт з master_id в історії — get_available_slots з цим master_id (слоти того майстра). Новий клієнт або без майстра — без master_id (найближчі вікна / день, який назвав клієнт). Клієнту лише імена майстрів, не id.',
      'Дві+ послуги одночасно до різних майстрів — get_available_slots з services[].master_id на кожному рядку (спільні години). Не став одного master_id на всі рядки, якщо клієнт обрав різних людей.',
      'Клієнт міняє майстрів місцями (swap) або додає ще послугу на той самий час — ОБОВʼЯЗКОВО новий get_available_slots з оновленими master_id; заборонено казати «обидві вільні» без свіжого tool.',
      'Немає спільних вікон — кажи дати/години з tool (або сусідні дні з результату). Не вигадуй «лист очікування», якщо салону немає такого процесу.',
      'Після get_available_slots з master_id дивись блок «Ціни для обраного майстра»: фіксовану суму цитуй клієнту; якщо «недоступно для цього майстра» — поясни коротко і запропонуй іншого майстра / рівень (новий виклик без цього master_id або з іншим). Не підставляй мінімум з діапазону чужого грейду.',
      `Заборонено обіцяти «зараз перевірю вікна / розклад» без ${invoke('get_available_slots')} у ТІЙ САМІЙ відповіді (коли вже є послуга з id + duration_min і дата/період).`,
      'Якщо в результаті get_available_slots є рядок «Тривалість для слотів: N хв (історія…)» — використовуй цю тривалість (платформа вже підставила її в free_time). Не зменшуй слот нижче recommended без згоди клієнта.',
    );
  }
  if (names.has('get_client_crm_history')) {
    rules.push(
      'Після телефону (update_client_info) для повторного клієнта — виклич get_client_crm_history (краще з service_id/service_query з search_services). Дивись РЕКОМЕНДОВАНА_ТРИВАЛІСТЬ і озвуч орієнтир клієнту.',
      'Для слотів/запису довіряй тривалості з tool result (історія actual/booked); не вигадуй і не став сліпо лише каталожну duration_min, якщо історія каже інакше.',
    );
  }
  if (names.has('submit_brief')) {
    rules.push(
      'submit_brief — коли зібрано достатньо кваліфікації ліда (див. опис інструменту); не викликай collect_order — його немає в цьому режимі.',
    );
  }
  if (names.has('classify_intent')) {
    rules.push(
      'classify_intent — на початку / при зміні теми, щоб зафіксувати intent розмови.',
    );
  }
  if (names.has('update_client_info')) {
    rules.push(
      'Зберігай контакти одразу через update_client_info, як тільки клієнт їх назвав.',
    );
  }
  if (names.has('request_handoff')) {
    rules.push(
      'request_handoff — коли потрібен живий менеджер (див. опис інструменту).',
    );
  }
  if (names.has('collect_order') || names.has('create_local_order')) {
    rules.push(
      'Якщо розмова вже у менеджера (handoff / менеджер перехопив) — collect_order / create_local_order НЕ викликай.',
    );
  }
  if (names.has('create_local_order') && names.has('collect_order')) {
    rules.push(
      'Не плутай: create_local_order = м\'яка згода / послуга / дзвінок; collect_order = повне оформлення з НП.',
    );
  }

  const rulesBlock = rules.map((r) => `- ${r}`).join('\n');

  if (nativeAll) {
    return `════════════════════════════════════════
ІНСТРУМЕНТИ (NATIVE MCP)
════════════════════════════════════════

Усі tools цього режиму — native. НЕ малюй блоки <tool_call> і не пиши JSON схем у відповіді клієнту.
Не стверджуй «записала / замовлення оформлено» без успішного tool.

Правила для цього режиму:
${rulesBlock}`;
  }

  const protocolIntro = nativeLookup
    ? `Lookup (пошук/слоти/історія/доставка) — native tools. Terminal інструменти нижче викликай так (після тексту для клієнта):`
    : `Ти МУСИШ викликати інструменти зі списку нижче, коли настають відповідні умови.

Формат виклику (наприкінці відповіді, після тексту для клієнта):`;

  const jsonLabel = nativeLookup
    ? 'Terminal інструменти (text protocol):'
    : 'Доступні інструменти:';

  return `════════════════════════════════════════
ІНСТРУМЕНТИ (ОБОВ'ЯЗКОВО)
════════════════════════════════════════

${protocolIntro}

<tool_call>
{"name":"ім'я_інструменту","args":{...}}
</tool_call>

Кілька інструментів — окремий блок для кожного.

Правила для цього режиму:
${rulesBlock}

${jsonLabel}
${toolsJson}`;
}
