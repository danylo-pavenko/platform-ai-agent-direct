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
- Коли пишеш клієнту підсумок замовлення (наприклад «підтверджую замовлення» з рядками Товар / Отримувач / Телефон / Доставка / Оплата) — у ТІЙ САМІЙ відповіді ОБОВ'ЯЗКОВО виклич collect_order. Саме тоді замовлення з'являється в адмінці (локальна БД); Telegram-картка менеджерам і дзеркало в CRM (якщо write увімкнено) ідуть з бекенду автоматично — окремого tool для Telegram/CRM немає.
- Коли клієнт підтвердив замовлення («так», «все вірно», «дякую, все вірно») і зібрані всі поля — теж ОБОВ'ЯЗКОВО collect_order у тій самій відповіді.
- Якщо розмова вже у менеджера (handoff / менеджер перехопив) — collect_order НЕ викликай, бот не відповідає.
- payment_method у collect_order: card (онлайн/WayForPay), transfer (банківський переказ), cod (післяплата).
- Зберігай контакти одразу через update_client_info, як тільки клієнт їх назвав.
- request_handoff — коли потрібен живий менеджер (див. опис інструменту).

Доступні інструменти:
${toolsJson}`;
}
