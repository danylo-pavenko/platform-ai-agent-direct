import type { ToolDefinition } from '../services/claude.js';

export const salesAgentTools: ToolDefinition[] = [
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
