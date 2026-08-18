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
      'Скасування оплати / повернення коштів — немає tool. request_handoff, не вигадуй refund у CRM.',
    );
  }
  if (names.has('book_appointment')) {
    rules.push(
      'Коли клієнт підтвердив слот (дата/час/послуга/філія за потреби) — у ТІЙ САМІЙ відповіді ОБОВʼЯЗКОВО виклич book_appointment (ПІБ, телефон, дата ДД.ММ.РРРР, час, services[{id,duration_min,master_id якщо різні майстри}]). Один майстер на всі послуги — top-level master_id. Паралельно до різних майстрів — master_id на КОЖНОМУ рядку services (з get_available_slots); інакше обидві послуги сядуть на одного і CRM дасть TIME_CONFLICT.',
      'Заборонено писати клієнту «записала / записав / чекаємо тебе / бачимось о HH:MM / запис підтверджено» без <tool_call> book_appointment у ТІЙ САМІЙ відповіді. Відповідь лише про ціну/тривалість — БЕЗ підтвердження візиту, якщо book_appointment не викликано.',
      'Дати всюди українським форматом ДД.ММ.РРРР (08.08.2026). Не використовуй YYYY-MM-DD у tool args і в тексті клієнту.',
      'Немає tool на скасування, перенесення запису чи повернення оплати. Якщо клієнт просить скасувати візит, перенести на інший день/час або скасувати/повернути оплату — request_handoff (не вигадуй cancel/reschedule). Заборонено «переносити» повторним book_appointment: інша дата = другий запис у CRM, старий лишиться.',
    );
  }
  if (names.has('search_services')) {
    rules.push(
      'Заборонено писати клієнту «зараз пошукаю / перевірю / шукаю в каталозі / зараз буде» без <tool_call> search_services у ТІЙ САМІЙ відповіді. Якщо послуга вже зрозуміла — одразу виклич search_services і в наступному кроці назви ціну/тривалість з результату. Уточнювальне питання можна ставити БЕЗ обіцянки «зараз пошукаю».',
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
      'Заборонено писати «зараз пошукаю / перевірю в каталозі» без <tool_call> search_catalog у ТІЙ САМІЙ відповіді. Якщо товар/запит зрозумілий — одразу search_catalog і відповідай фактами з результату.',
    );
  }
  if (names.has('get_available_slots')) {
    rules.push(
      'Повторний клієнт з master_id в історії — get_available_slots з цим master_id (слоти того майстра). Новий клієнт або без майстра — без master_id (найближчі вікна / день, який назвав клієнт). Клієнту лише імена майстрів, не id.',
      'Дві+ послуги одночасно до різних майстрів — get_available_slots з services[].master_id на кожному рядку (спільні години). Не став одного master_id на всі рядки, якщо клієнт обрав різних людей.',
      'Після get_available_slots з master_id дивись блок «Ціни для обраного майстра»: фіксовану суму цитуй клієнту; якщо «недоступно для цього майстра» — поясни коротко і запропонуй іншого майстра / рівень (новий виклик без цього master_id або з іншим). Не підставляй мінімум з діапазону чужого грейду.',
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
