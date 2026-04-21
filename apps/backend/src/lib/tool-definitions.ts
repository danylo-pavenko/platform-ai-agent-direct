import type { ToolDefinition } from '../services/claude.js';
import type { CrmFieldMapping } from '../generated/prisma/client.js';

// Stable base tool set shared by every conversation, regardless of
// tenant-specific CRM field mappings. Kept as a private const so the
// public `buildSalesAgentTools()` is the single construction path
// (dynamic or not).
const BASE_TOOLS: ToolDefinition[] = [
  {
    // Saves customer contact and delivery information to their profile.
    // Claude should call this as soon as the client shares a phone number,
    // full name, or Nova Poshta delivery details - even mid-conversation,
    // without waiting for the order to be placed.
    name: 'update_client_info',
    description:
      'Зберегти контактні або доставочні дані клієнта. Викликай одразу, як тільки клієнт назвав ПІБ, телефон, місто чи відділення НП - не чекай кінця оформлення замовлення.',
    parameters: {
      type: 'object',
      properties: {
        full_name: {
          type: 'string',
          description: "Повне ім'я (ПІБ) клієнта як він/вона назвав(ла)",
        },
        phone: {
          type: 'string',
          description: 'Номер телефону (зберігати як є, без форматування)',
        },
        city: {
          type: 'string',
          description: 'Місто для відправки Новою Поштою',
        },
        np_branch: {
          type: 'string',
          description: 'Номер відділення або адреса поштомату НП',
        },
        np_type: {
          type: 'string',
          enum: ['warehouse', 'postamat'],
          description: 'warehouse = відділення НП; postamat = поштомат НП',
        },
        email: {
          type: 'string',
          description: 'Email-адреса клієнта',
        },
      },
      // All fields are optional - Claude can call with just what it knows
      required: [],
    },
  },
  {
    name: 'tag_client',
    description:
      'Додати теги до профілю клієнта для майбутньої персоналізації та рекламних кампаній. Викликай в кінці розмови або коли стає зрозуміло хто клієнт. Теги допомагають у ретаргетингу.',
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Список тегів. Приклади: "vip", "repeat_buyer", "print_fan", "embroidery", "budget", "gifting", "wholesale_inquiry", "lost_lead"',
        },
        notes: {
          type: 'string',
          description: 'Корисна нотатка про клієнта для менеджера (необов\'язково). Наприклад: "Цікавиться принтами, але обирає довго. Підходять подарунки."',
        },
      },
      required: ['tags'],
    },
  },
  {
    name: 'get_delivery_cost',
    description:
      'Отримати вартість доставки Новою Поштою по Украъни. Викликай коли клієнт запитує скільки коштує доставка до його міста. Для міжнародної доставки - ескалюй до менеджера.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'Місто отримувача українською (наприклад "Харків", "Одеса", "Дніпро")',
        },
        weight_kg: {
          type: 'number',
          description: 'Орієнтовна вага відправлення в кг. Якщо невідома - передай 0.5',
        },
        declared_value: {
          type: 'number',
          description: 'Оголошена вартість замовлення в грн. Якщо невідома - передай 500',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'request_handoff',
    description:
      'Передати розмову менеджеру-людині. Викликай коли: скарга/брак, запит на повернення, клієнт прямо просить людину, ти двічі не зміг відповісти впевнено, опт/співпраця, доставка за кордон, офіційні документи.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Коротке пояснення чому ескалюєш (для менеджера, не клієнта)',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'urgent'],
          description: 'urgent = брак, скарга, конфлікт',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'collect_order',
    description:
      'Зібрано замовлення. Викликай ТІЛЬКИ коли клієнт підтвердив ВСІ деталі: товар, ПІБ, телефон, місто+НП, оплата.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              variant: { type: 'string', description: 'Колір, розмір тощо' },
              price: { type: 'number' },
              qty: { type: 'number', default: 1 },
            },
            required: ['name', 'price'],
          },
        },
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        city: { type: 'string' },
        np_branch: {
          type: 'string',
          description: 'Номер або адреса відділення НП',
        },
        payment_method: {
          type: 'string',
          enum: ['card', 'transfer', 'cod'],
        },
        note: {
          type: 'string',
          description: 'Додаткові побажання клієнта',
        },
      },
      required: ['items', 'customer_name', 'phone', 'city', 'np_branch', 'payment_method'],
    },
  },
];

/**
 * Picks the JSON-schema shape for a CRM custom field based on its
 * KeyCRM-style type hint. Everything unknown falls back to `string`
 * so Claude always has a valid schema to target.
 */
function customFieldSchema(
  m: CrmFieldMapping,
): Record<string, unknown> {
  const hint = m.promptHint?.trim();
  const description = hint ? `${m.label} — ${hint}` : m.label;

  switch (m.extractType) {
    case 'number':
    case 'float':
      return { type: 'number', description };
    case 'switcher':
      return { type: 'boolean', description };
    case 'select':
      return m.options.length > 0
        ? { type: 'string', enum: m.options, description }
        : { type: 'string', description };
    default:
      return { type: 'string', description };
  }
}

/**
 * Builds the per-turn tool definitions. When the tenant has active
 * buyer-scope CrmFieldMapping rows, `update_client_info` gains an
 * optional `custom_fields` object whose properties are the mapped
 * local slugs — giving Claude a structured way to hand back extracted
 * values (e.g. `{ clothing_size: "L" }`).
 *
 * `order`-scope mappings are intentionally *not* injected here yet —
 * they'll be added to `collect_order` in a later phase once we decide
 * how to collect them across multi-turn order assembly.
 */
export function buildSalesAgentTools(
  buyerScopeMappings: CrmFieldMapping[] = [],
): ToolDefinition[] {
  if (buyerScopeMappings.length === 0) return BASE_TOOLS;

  const properties: Record<string, Record<string, unknown>> = {};
  for (const m of buyerScopeMappings) {
    properties[m.localKey] = customFieldSchema(m);
  }

  return BASE_TOOLS.map((tool) => {
    if (tool.name !== 'update_client_info') return tool;

    const params = tool.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };

    return {
      ...tool,
      parameters: {
        ...params,
        properties: {
          ...params.properties,
          custom_fields: {
            type: 'object',
            description:
              'Додаткові поля клієнта з активного CRM-мапінгу. Заповнюй лише ті ключі, про які клієнт явно сказав. Якщо не знаєш значення — не додавай ключ.',
            properties,
          },
        },
      },
    };
  });
}

// Backwards-compat export — existing callers that still import the flat
// array keep working until they migrate to buildSalesAgentTools().
export const salesAgentTools: ToolDefinition[] = BASE_TOOLS;
