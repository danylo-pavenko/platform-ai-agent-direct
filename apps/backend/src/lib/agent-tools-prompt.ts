import type { ToolDefinition } from '../services/claude.js';

/**
 * Formats agent tool schemas + invocation protocol for the Claude CLI prompt.
 * Native CLI tool_use is not available in headless `-p` mode, so we embed
 * definitions and require `<tool_call>` JSON blocks in the assistant reply.
 *
 * Rules are derived from the *actual* tool list for this turn — never instruct
 * sales collect_order when the tenant is in leadgen (and vice versa). That
 * mismatch was causing English “wrong toolset” rants in Instagram DM.
 */
export function formatAgentToolsPrompt(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const names = new Set(tools.map((t) => t.name));
  const toolsJson = JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    null,
    2,
  );

  const rules: string[] = [
    'Клієнт бачить лише твій текст — блоки <tool_call> для нього невидимі.',
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
    );
  }
  if (names.has('book_appointment')) {
    rules.push(
      'book_appointment — коли клієнт підтвердив слот запису (дата/час/послуга/філія за потреби). Передай master_id з get_available_slots або історії, якщо клієнт йде до конкретного майстра.',
    );
  }
  if (names.has('search_services')) {
    rules.push(
      'Заборонено писати клієнту «зараз пошукаю / перевірю / шукаю в каталозі / зараз буде» без <tool_call> search_services у ТІЙ САМІЙ відповіді. Якщо послуга вже зрозуміла — одразу виклич search_services і в наступному кроці назви ціну/тривалість з результату. Уточнювальне питання можна ставити БЕЗ обіцянки «зараз пошукаю».',
      'Якщо search_services повернув порожньо — НЕ вигадуй ціну/назву. Повторюй з коротшим query (манікюр, чистка, педикюр) або request_handoff.',
      'Якщо search_services повернув кілька схожих послуг — коротко уточни назву в клієнта (без service_id / UUID) і лише потім get_available_slots.',
      'Якщо клієнт уже назвав дату/час і search_services дав id+duration_min — у наступній відповіді ОБОВʼЯЗКОВО виклич get_available_slots і дай 2–3 конкретні вікна. Не зупиняйся на «зараз перевірю вікна».',
    );
  }
  if (names.has('search_catalog')) {
    rules.push(
      'Заборонено писати «зараз пошукаю / перевірю в каталозі» без <tool_call> search_catalog у ТІЙ САМІЙ відповіді. Якщо товар/запит зрозумілий — одразу search_catalog і відповідай фактами з результату.',
    );
  }
  if (names.has('get_available_slots')) {
    rules.push(
      'Повторний клієнт з master_id в історії — get_available_slots з цим master_id (слоти того майстра). Новий клієнт або без майстра — без master_id (найближчі вікна / день, який назвав клієнт). Клієнту лише імена майстрів, не id.',
      'Заборонено обіцяти «зараз перевірю вікна / розклад» без <tool_call> get_available_slots у ТІЙ САМІЙ відповіді (коли вже є послуга з id + duration_min і дата/період).',
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

  return `════════════════════════════════════════
ІНСТРУМЕНТИ (ОБОВ'ЯЗКОВО)
════════════════════════════════════════

Ти МУСИШ викликати інструменти зі списку нижче, коли настають відповідні умови.

Формат виклику (наприкінці відповіді, після тексту для клієнта):

<tool_call>
{"name":"ім'я_інструменту","args":{...}}
</tool_call>

Кілька інструментів — окремий блок для кожного.

Правила для цього режиму:
${rulesBlock}

Доступні інструменти:
${toolsJson}`;
}
