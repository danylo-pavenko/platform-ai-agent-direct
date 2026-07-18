import type { ToolDefinition } from '../services/claude.js';
import type { CrmFieldMapping } from '../generated/prisma/client.js';

export type AgentMode = 'sales' | 'leadgen' | 'booking';

// ── Shared tools (both modes) ──────────────────────────────────────────────

const UPDATE_CLIENT_INFO: ToolDefinition = {
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
    required: [],
  },
};

const TAG_CLIENT: ToolDefinition = {
  name: 'tag_client',
  description:
    'Додати теги до профілю клієнта для майбутньої персоналізації та рекламних кампаній. Викликай в кінці розмови або коли стає зрозуміло хто клієнт. Теги допомагають у ретаргетингу.',
  parameters: {
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Список тегів. Приклади: "vip", "repeat_buyer", "print_fan", "embroidery", "budget", "gifting", "wholesale_inquiry", "lost_lead", "hot", "warm", "cold"',
      },
      notes: {
        type: 'string',
        description:
          "Корисна нотатка про клієнта для менеджера (необов'язково).",
      },
    },
    required: ['tags'],
  },
};

const REQUEST_HANDOFF: ToolDefinition = {
  name: 'request_handoff',
  description:
    'Передати розмову менеджеру-людині. Викликай коли: скарга/брак, запит на повернення, клієнт прямо просить людину, ти двічі не зміг відповісти впевнено, опт/співпраця, доставка за кордон, офіційні документи, юридичні питання, тиск по ціні.',
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
        description: 'urgent = брак, скарга, конфлікт, негатив, агресія',
      },
    },
    required: ['reason'],
  },
};

// Intent is stored as free-form text in conversations.intent (not a DB enum),
// so this whitelist lives in the tool schema only and can evolve without
// migrations. Keep the vocabulary stable enough for downstream analytics.
const CLASSIFY_INTENT: ToolDefinition = {
  name: 'classify_intent',
  description:
    'Класифікувати намір клієнта у розмові. Викликай НА ПЕРШОМУ повідомленні від клієнта, щоб зафіксувати тип звернення. Повторно викликати НЕ треба — лише якщо намір явно змінився посеред розмови.',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [
          'new_lead',
          'service_question',
          'product_question',
          'order',
          'complaint',
          'partnership',
          'jobs',
          'spam',
          'other',
        ],
        description:
          'new_lead = новий запит на послугу/проєкт; service_question = питання про послуги/продукти; product_question = питання по асортименту; order = хоче купити; complaint = рекламація/скарга; partnership = опт/співпраця; jobs = вакансія/стажування; spam = спам/нерелевантне; other = не підходить ні під що',
      },
      confidence: {
        type: 'number',
        description: 'Впевненість 0..1. Якщо <0.5 — одразу викликай request_handoff.',
      },
    },
    required: ['intent'],
  },
};

const SET_CONVERSATION_BRANCH: ToolDefinition = {
  name: 'set_conversation_branch',
  description:
    'Зафіксувати обрану клієнтом філію/локацію салону. Викликай після того, як клієнт назвав або підтвердив район/адресу. Використовуй slug зі списку філій у промпті.',
  parameters: {
    type: 'object',
    properties: {
      branch_slug: {
        type: 'string',
        description: 'Внутрішній slug філії, наприклад obolon або center',
      },
    },
    required: ['branch_slug'],
  },
};

// ── Booking-mode tools ─────────────────────────────────────────────────────

const SEARCH_SERVICES: ToolDefinition = {
  name: 'search_services',
  description:
    'Пошук послуг у CRM (назва, ціна, тривалість). Викликай коли клієнт питає про послугу, ціну або процедуру.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Ключові слова з запиту клієнта' },
      crm_provider: {
        type: 'string',
        enum: ['cleverbox', 'beautypro', 'keycrm'],
        description: 'Лише якщо системний промпт вказує інший CRM для послуг',
      },
    },
    required: ['query'],
  },
};

const GET_AVAILABLE_SLOTS: ToolDefinition = {
  name: 'get_available_slots',
  description:
    'Вільні слоти для запису на обрану дату. Потрібна філія (set_conversation_branch) та список послуг з id і тривалістю.',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Дата ДД.ММ.РРРР' },
      services: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'ID послуги з search_services (число або UUID)',
            },
            duration_min: { type: 'number' },
          },
          required: ['id', 'duration_min'],
        },
      },
      full_month: { type: 'boolean', description: 'Показати слоти на весь місяць' },
    },
    required: ['date', 'services'],
  },
};

const BOOK_APPOINTMENT: ToolDefinition = {
  name: 'book_appointment',
  description:
    'Підтвердити запис у CRM. Викликай лише після згоди клієнта і коли є: ПІБ, телефон, дата, час, послуги, філія (set_conversation_branch).',
  parameters: {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      phone: { type: 'string' },
      date: { type: 'string', description: 'ДД.ММ.РРРР' },
      time: { type: 'string', description: 'ГГ:ХХ' },
      services: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'ID послуги з search_services (число або UUID)',
            },
            name: { type: 'string' },
            price: { type: 'number' },
            duration_min: { type: 'number' },
          },
          required: ['id', 'name', 'duration_min'],
        },
      },
      master_id: {
        type: 'string',
        description: 'ID майстра з get_available_slots (число або UUID)',
      },
      comment: { type: 'string' },
      crm_provider: {
        type: 'string',
        enum: ['cleverbox', 'beautypro', 'keycrm'],
        description: 'Лише якщо промпт вказує інший CRM для запису',
      },
    },
    required: ['customer_name', 'phone', 'date', 'time', 'services'],
  },
};

const ATTACH_REFERENCE_PHOTO: ToolDefinition = {
  name: 'attach_reference_photo',
  description:
    'Зберегти референс-фото від клієнта (колір волосся, приклад стрижки тощо). Викликай коли клієнт надіслав фото в цій розмові.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Короткий опис фото для менеджера' },
      storage_key: {
        type: 'string',
        description: 'Ключ збереженого вкладення з повідомлення (якщо відомий)',
      },
    },
    required: [],
  },
};

const GET_CLIENT_CRM_HISTORY: ToolDefinition = {
  name: 'get_client_crm_history',
  description:
    'Історія візитів клієнта з CRM (тривалість попередніх послуг, майстер, дати). Викликай перед записом, якщо клієнт уже дав телефон, або щоб уточнити скільки часу займала минула послуга.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── Sales-mode-only tools ──────────────────────────────────────────────────

const SEARCH_CATALOG: ToolDefinition = {
  name: 'search_catalog',
  description:
    'Живий пошук товару в каталозі (наявність, ціни, варіанти розміру/кольору). Викликай, коли клієнт питає про конкретний товар, модель, розмір, колір або наявність — не покладайся лише на знімок каталогу в промпті.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Ключові слова з запиту клієнта (назва, модель, колір)',
      },
    },
    required: ['query'],
  },
};

const GET_DELIVERY_COST: ToolDefinition = {
  name: 'get_delivery_cost',
  description:
    'Отримати вартість доставки Новою Поштою по Україні. Викликай коли клієнт запитує скільки коштує доставка до його міста. Для міжнародної доставки - ескалюй до менеджера.',
  parameters: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: 'Місто отримувача українською',
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
};

const COLLECT_ORDER: ToolDefinition = {
  name: 'collect_order',
  description:
    'Зібрано замовлення. Викликай ОБОВ\'ЯЗКОВО коли клієнт підтвердив («так», «все вірно», «дякую») і є: товар, ПІБ, телефон, місто+НП, оплата. Без цього виклику замовлення НЕ створюється в системі.',
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
};

// ── Leadgen-mode-only tool ─────────────────────────────────────────────────

const SUBMIT_BRIEF: ToolDefinition = {
  name: 'submit_brief',
  description:
    'Передати пресейл-бриф менеджеру. Викликай ТІЛЬКИ коли зібрано мінімум: тип послуги/запиту, ніша бізнесу та хоч один канал звʼязку (телефон / email / Telegram). Усі інші поля — необовʼязкові; передавай лише ті, які вдалось зʼясувати з розмови. Не вигадуй значень і не випитуй агресивно.',
  parameters: {
    type: 'object',
    properties: {
      // Identification
      business_name: { type: 'string', description: 'Назва бізнесу / бренду клієнта' },
      niche: { type: 'string', description: 'Ніша / галузь (наприклад "кавʼярня", "SaaS B2B", "онлайн-курси")' },
      role: { type: 'string', description: 'Роль того, хто пише (власник / маркетолог / асистент)' },
      client_type: {
        type: 'string',
        enum: ['b2c', 'b2b', 'mixed', 'unknown'],
        description: 'Тип бізнесу ліда',
      },

      // Request
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Які послуги цікавлять. Значення відповідають списку в services.txt.',
      },
      goal: { type: 'string', description: 'Коротка бізнес-ціль («більше заявок», «вийти на новий ринок»)' },
      desired_result: { type: 'string', description: 'Що саме вважатиме успіхом (цифри / етапи, якщо назвав)' },
      kpi: { type: 'string', description: 'Які метрики лід хоче бачити (ROAS, CAC, ліди/міс тощо)' },

      // Current situation
      current_activity: { type: 'string', description: 'Що вже робили в маркетингу / з ким працювали' },
      previous_contractors: { type: 'string', description: 'Попередні підрядники / агенції, якщо назвав' },
      pain_points: { type: 'string', description: 'Що не влаштовує зараз, основні болі' },

      // Business
      size: { type: 'string', description: 'Розмір бізнесу (кількість співробітників, оборот, якщо ділиться)' },
      geo: { type: 'string', description: 'Географія клієнтів (Україна / ЄС / глобально / регіон)' },

      // Channels / assets
      website_url: { type: 'string', description: 'URL сайту, якщо є' },
      instagram_url: { type: 'string', description: 'URL Instagram-сторінки' },
      other_channels: { type: 'string', description: 'Інші канали (TikTok, Telegram, YouTube)' },

      // Budget
      budget_range: { type: 'string', description: 'Діапазон бюджету (наприклад "$500–1000/міс")' },
      budget_period: { type: 'string', description: 'Період («щомісяця», «за проєкт»)' },

      // Timing
      desired_start: { type: 'string', description: 'Бажаний старт («ASAP», «з наступного місяця»)' },
      deadlines: { type: 'string', description: 'Дедлайни або привʼязки до подій' },

      // Contacts
      phone: { type: 'string', description: 'Телефон' },
      email: { type: 'string', description: 'Email' },
      preferred_channel: {
        type: 'string',
        enum: ['phone', 'telegram', 'direct', 'email', 'whatsapp', 'viber', 'other'],
        description: 'Зручний канал для звʼязку',
      },
      preferred_time: { type: 'string', description: 'Зручний час + часовий пояс' },

      // Classification
      segment: { type: 'string', description: 'Сегмент ліда (наприклад "SMB", "enterprise")' },
      priority: {
        type: 'string',
        enum: ['hot', 'warm', 'cold'],
        description: 'Гарячість ліда на основі сигналів у діалозі',
      },
      source: { type: 'string', description: 'Джерело (якщо клієнт сам каже звідки дізнався)' },

      confidence: {
        type: 'number',
        description: 'Впевненість у зібраній інформації 0..1',
      },
    },
    required: [],
  },
};

// ── Custom-field schema helper ─────────────────────────────────────────────

function customFieldSchema(m: CrmFieldMapping): Record<string, unknown> {
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

function injectCustomFields(
  tool: ToolDefinition,
  mappings: CrmFieldMapping[],
  description: string,
): ToolDefinition {
  if (mappings.length === 0) return tool;

  const properties: Record<string, Record<string, unknown>> = {};
  for (const m of mappings) {
    properties[m.localKey] = customFieldSchema(m);
  }

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
          description,
          properties,
        },
      },
    },
  };
}

// ── Public entry point ────────────────────────────────────────────────────

export interface BuildAgentToolsOptions {
  buyerScopeMappings?: CrmFieldMapping[];
  leadScopeMappings?: CrmFieldMapping[];
  /** When true, inject set_conversation_branch for multi-location tenants. */
  hasBranches?: boolean;
}

/**
 * Builds the per-turn tool surface for a given agent mode.
 *
 * Sales mode  → update_client_info, tag_client, request_handoff,
 *               get_delivery_cost, collect_order.
 * Leadgen mode → classify_intent, update_client_info, tag_client,
 *                request_handoff, submit_brief.
 *
 * `update_client_info` always gains a dynamic `custom_fields` object
 * from buyer-scope CRM mappings (both modes).
 * `submit_brief` gains a dynamic `custom_fields` object from lead-scope
 * CRM mappings (leadgen only) — these land on the pipeline card.
 */
export function buildAgentTools(
  mode: AgentMode,
  opts: BuildAgentToolsOptions = {},
): ToolDefinition[] {
  const buyer = opts.buyerScopeMappings ?? [];
  const lead = opts.leadScopeMappings ?? [];
  const hasBranches = opts.hasBranches ?? false;

  const updateClientInfo = injectCustomFields(
    UPDATE_CLIENT_INFO,
    buyer,
    'Додаткові поля клієнта з активного CRM-мапінгу. Заповнюй лише ті ключі, про які клієнт явно сказав. Якщо не знаєш значення — не додавай ключ.',
  );

  const sharedBase: ToolDefinition[] = [updateClientInfo];
  if (hasBranches) sharedBase.push(SET_CONVERSATION_BRANCH);
  sharedBase.push(TAG_CLIENT, REQUEST_HANDOFF);

  if (mode === 'leadgen') {
    const submitBrief = injectCustomFields(
      SUBMIT_BRIEF,
      lead,
      'Додаткові поля пресейл-брифу з CRM-мапінгу (lead scope). Заповнюй лише те, про що клієнт явно сказав.',
    );
    return [CLASSIFY_INTENT, ...sharedBase, submitBrief];
  }

  if (mode === 'booking') {
    return [
      CLASSIFY_INTENT,
      ...sharedBase,
      SEARCH_SERVICES,
      GET_AVAILABLE_SLOTS,
      GET_CLIENT_CRM_HISTORY,
      ATTACH_REFERENCE_PHOTO,
      BOOK_APPOINTMENT,
    ];
  }

  // sales
  return [
    ...sharedBase,
    SEARCH_CATALOG,
    GET_DELIVERY_COST,
    COLLECT_ORDER,
  ];
}
