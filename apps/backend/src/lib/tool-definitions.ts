import type { ToolDefinition } from '../services/claude.js';

export const salesAgentTools: ToolDefinition[] = [
  {
    // Saves customer contact and delivery information to their profile.
    // Claude should call this as soon as the client shares a phone number,
    // full name, or Nova Poshta delivery details — even mid-conversation,
    // without waiting for the order to be placed.
    name: 'update_client_info',
    description:
      'Зберегти контактні або доставочні дані клієнта. Викликай одразу, як тільки клієнт назвав ПІБ, телефон, місто чи відділення НП — не чекай кінця оформлення замовлення.',
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
      // All fields are optional — Claude can call with just what it knows
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
