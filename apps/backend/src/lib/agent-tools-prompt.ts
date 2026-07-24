import type { ToolDefinition } from '../services/claude.js';

/**
 * Formats agent tool schemas + invocation protocol for the Claude CLI prompt.
 * Native CLI tool_use is not available in headless `-p` mode, so we embed
 * definitions and require `<tool_call>` JSON blocks in the assistant reply.
 */
export function formatAgentToolsPrompt(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const toolsJson = JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    null,
    2,
  );

  return `════════════════════════════════════════
ІНСТРУМЕНТИ (ОБОВ'ЯЗКОВО)
════════════════════════════════════════

Ти МУСИШ викликати інструменти, коли настають відповідні умови. Клієнт бачить лише твій текст — блоки <tool_call> для нього невидимі.

Формат виклику (наприкінці відповіді, після тексту для клієнта):

<tool_call>
{"name":"ім'я_інструменту","args":{...}}
</tool_call>

Кілька інструментів — окремий блок для кожного.

Критичні правила:
- Коли клієнт явно погодився на товар, послугу, дзвінок або сказав «оформляйте» / «давайте» — у ТІЙ САМІЙ відповіді виклич create_local_order (kind + summary). Це одразу створює локальну заявку в адмінці (Замовлення) і картку в Telegram; CRM НЕ дзеркалить. Контакти передавай, якщо вже є.
- Коли пишеш клієнту ПОВНИЙ підсумок e-commerce замовлення (Товар / Отримувач / Телефон / Доставка НП / Оплата) — у ТІЙ САМІЙ відповіді ОБОВ'ЯЗКОВО виклич collect_order (лише sales). Тоді локальна БД + Telegram + CRM mirror (якщо write увімкнено).
- Коли клієнт підтвердив повне замовлення («так», «все вірно») і зібрані всі поля доставки — теж collect_order.
- Не плутай: create_local_order = м'яка згода / послуга / дзвінок; collect_order = повне оформлення з НП; book_appointment = слот у CRM запису.
- Якщо розмова вже у менеджера (handoff / менеджер перехопив) — collect_order / create_local_order НЕ викликай.
- payment_method у collect_order: card (онлайн/WayForPay), transfer (банківський переказ), cod (післяплата).
- Зберігай контакти одразу через update_client_info, як тільки клієнт їх назвав.
- request_handoff — коли потрібен живий менеджер (див. опис інструменту).

Доступні інструменти:
${toolsJson}`;
}
