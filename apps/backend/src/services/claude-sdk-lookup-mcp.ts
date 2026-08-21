/**
 * In-process MCP lookup tools for Claude Agent SDK (Phase 2).
 * Handlers call `executeLookupTool` — the same path as conversation.ts.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  LOOKUP_TOOL_NAMES,
  PROFILE_TOOL_NAMES,
  TERMINAL_TOOL_NAMES,
  canonicalToolName,
  isLookupToolName,
  isPlatformMcpToolName,
  mcpLookupToolName,
  CLAUDE_SDK_MCP_SERVER_NAME,
  type LookupToolName,
} from '../lib/tool-definitions.js';
import type { ToolDefinition } from '../lib/claude-runtime.js';
import { executeLookupTool, type LookupToolContext } from './agent-lookup-tools.js';

export { CLAUDE_SDK_MCP_SERVER_NAME, canonicalToolName, mcpLookupToolName };

const LOOKUP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function mcpTextResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const HOST_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

const PROFILE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Drop CRM history unless the client is linked in booking mode. */
export function lookupToolsForMcp(
  tools: ToolDefinition[] | undefined,
  ctx: LookupToolContext | undefined,
): LookupToolName[] {
  const names = (tools ?? [])
    .map((t) => t.name)
    .filter((n): n is LookupToolName => isLookupToolName(n));
  return names.filter((name) => {
    if (name === 'get_client_crm_history') {
      return Boolean(ctx?.crmHistoryAllowed && ctx.clientId);
    }
    return true;
  });
}

/** Lookup + profile + terminal tools registered on the in-process MCP server. */
export function platformToolsForMcp(
  tools: ToolDefinition[] | undefined,
  ctx: LookupToolContext | undefined,
): string[] {
  const lookups = lookupToolsForMcp(tools, ctx);
  const names = (tools ?? []).map((t) => t.name).filter(isPlatformMcpToolName);
  const mutationsAllowed = ctx?.mutationsAllowed !== false;
  const rest = names.filter((name) => {
    if (isLookupToolName(name)) return false;
    if (
      !mutationsAllowed &&
      (name === 'book_appointment' ||
        name === 'collect_order' ||
        name === 'create_local_order' ||
        name === 'submit_brief')
    ) {
      return false;
    }
    return true;
  });
  return [...lookups, ...rest];
}

export function mcpAllowedToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) =>
    name.startsWith('mcp__') ? name : `mcp__${CLAUDE_SDK_MCP_SERVER_NAME}__${name}`,
  );
}

const SEARCH_SERVICES_SCHEMA = {
  query: z.string().describe('Ключові слова з запиту клієнта'),
  limit: z.number().optional().describe('Скільки варіантів повернути (1–20)'),
  crm_provider: z
    .enum(['cleverbox', 'beautypro', 'keycrm'])
    .optional()
    .describe('Лише якщо системний промпт вказує інший CRM для послуг'),
};

const SEARCH_CATALOG_SCHEMA = {
  query: z.string().describe('Ключові слова з запиту клієнта (назва, модель, колір)'),
};

const DELIVERY_SCHEMA = {
  city: z.string().describe('Місто отримувача українською'),
  weight_kg: z.number().optional().describe('Орієнтовна вага в кг. Якщо невідома — 0.5'),
  declared_value: z.number().optional().describe('Оголошена вартість у грн. Якщо невідома — 500'),
};

const SLOTS_SCHEMA = {
  date: z.string().describe('Дата обовʼязково ДД.ММ.РРРР (напр. 08.08.2026), не YYYY-MM-DD'),
  services: z
    .array(
      z.object({
        id: z.string().describe('ID послуги з search_services (число або UUID)'),
        duration_min: z.number(),
        master_id: z.string().optional(),
      }),
    )
    .describe('Послуги з id + duration_min з search_services'),
  full_month: z.boolean().optional(),
  master_id: z.string().optional().describe('ID майстра з CRM історії / слотів'),
};

const HISTORY_SCHEMA = {
  service_id: z.string().optional(),
  service_query: z.string().optional(),
  duration_min: z.number().optional(),
  master_id: z.string().optional(),
};

const LOOSE_OBJECT = z.record(z.string(), z.unknown()).optional();

function lookupHandler(name: LookupToolName, ctx: LookupToolContext) {
  return (async (args: Record<string, unknown>) =>
    mcpTextResult(await executeLookupTool(name, args, ctx))) as never;
}

function hostQueuedHandler(name: string) {
  return (async () =>
    mcpTextResult(
      `[${name}] HOST_QUEUED — бекенд виконає після цього ходу. Не стверджуй клієнту успіх («записала / замовлення оформлено»), поки немає ok у наступному tool result.`,
    )) as never;
}

export function createLookupMcpServer(
  ctx: LookupToolContext,
  allow: string[],
) {
  const allowed = new Set(allow);
  const tools = [];

  if (allowed.has('search_services')) {
    tools.push(
      tool(
        'search_services',
        'Пошук послуг у CRM: назва, тривалість, ціна. Порожній результат — не вигадуй ціну. Не світи UUID клієнту.',
        SEARCH_SERVICES_SCHEMA,
        lookupHandler('search_services', ctx),
        { annotations: LOOKUP_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('search_catalog')) {
    tools.push(
      tool(
        'search_catalog',
        'Живий пошук товару в каталозі. Не вигадуй наявність/ціну без результату. Не світи product_id клієнту.',
        SEARCH_CATALOG_SCHEMA,
        lookupHandler('search_catalog', ctx),
        { annotations: LOOKUP_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('get_delivery_cost')) {
    tools.push(
      tool(
        'get_delivery_cost',
        'Вартість доставки Новою Поштою по Україні.',
        DELIVERY_SCHEMA,
        lookupHandler('get_delivery_cost', ctx),
        { annotations: LOOKUP_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('get_available_slots')) {
    tools.push(
      tool(
        'get_available_slots',
        'Вільні слоти на дату. Клієнту лише імена майстрів, не id/UUID.',
        SLOTS_SCHEMA,
        lookupHandler('get_available_slots', ctx),
        { annotations: LOOKUP_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('get_client_crm_history')) {
    tools.push(
      tool(
        'get_client_crm_history',
        'Історія візитів привʼязаного CRM-клієнта (booking). Не світи UUID клієнту.',
        HISTORY_SCHEMA,
        lookupHandler('get_client_crm_history', ctx),
        { annotations: LOOKUP_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }

  if (allowed.has('update_client_info')) {
    tools.push(
      tool(
        'update_client_info',
        'Зберегти контактні дані клієнта, щойно він їх назвав.',
        {
          full_name: z.string().optional(),
          phone: z.string().optional(),
          city: z.string().optional(),
          np_branch: z.string().optional(),
          np_type: z.enum(['warehouse', 'postamat']).optional(),
          email: z.string().optional(),
          custom_fields: LOOSE_OBJECT,
        },
        hostQueuedHandler('update_client_info'),
        { annotations: PROFILE_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('tag_client')) {
    tools.push(
      tool(
        'tag_client',
        'Додати теги до профілю клієнта.',
        { tags: z.array(z.string()), notes: z.string().optional() },
        hostQueuedHandler('tag_client'),
        { annotations: PROFILE_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('set_conversation_branch')) {
    tools.push(
      tool(
        'set_conversation_branch',
        'Зафіксувати філію (slug зі списку в промпті).',
        { branch_slug: z.string() },
        hostQueuedHandler('set_conversation_branch'),
        { annotations: PROFILE_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('attach_reference_photo')) {
    tools.push(
      tool(
        'attach_reference_photo',
        'Зберегти референс-фото клієнта з цієї розмови.',
        { note: z.string().optional(), storage_key: z.string().optional() },
        hostQueuedHandler('attach_reference_photo'),
        { annotations: PROFILE_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('classify_intent')) {
    tools.push(
      tool(
        'classify_intent',
        'Класифікувати намір клієнта (на першому повідомленні).',
        { intent: z.string(), confidence: z.number().optional() },
        hostQueuedHandler('classify_intent'),
        { annotations: PROFILE_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('request_handoff')) {
    tools.push(
      tool(
        'request_handoff',
        'Передати розмову менеджеру. Скасування / перенесення запису / refund — лише цей tool.',
        { reason: z.string(), priority: z.enum(['normal', 'urgent']).optional() },
        hostQueuedHandler('request_handoff'),
        { annotations: HOST_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('book_appointment')) {
    tools.push(
      tool(
        'book_appointment',
        'Підтвердити запис у CRM після згоди клієнта. Не використовуй як reschedule. Не світи UUID клієнту. Не кажи «записала» без успішного result.',
        {
          customer_name: z.string(),
          phone: z.string(),
          date: z.string(),
          time: z.string(),
          services: z.array(
            z.object({
              id: z.string(),
              name: z.string().optional(),
              price: z.number().optional(),
              duration_min: z.number().optional(),
              master_id: z.string().optional(),
            }),
          ),
          master_id: z.string().optional(),
          comment: z.string().optional(),
          crm_provider: z.enum(['cleverbox', 'beautypro', 'keycrm']).optional(),
        },
        hostQueuedHandler('book_appointment'),
        { annotations: HOST_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('collect_order')) {
    tools.push(
      tool(
        'collect_order',
        'Повне e-commerce замовлення з НП. Не кажи «оформлено» без успішного result.',
        {
          items: z.array(
            z.object({
              name: z.string(),
              variant: z.string().optional(),
              price: z.number(),
              qty: z.number().optional(),
            }),
          ),
          customer_name: z.string(),
          phone: z.string(),
          city: z.string(),
          np_branch: z.string(),
          payment_method: z.enum(['card', 'transfer', 'cod']),
          note: z.string().optional(),
        },
        hostQueuedHandler('collect_order'),
        { annotations: HOST_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('create_local_order')) {
    tools.push(
      tool(
        'create_local_order',
        'Локальна заявка в адмінці при явній згоді (без CRM mirror).',
        {
          kind: z.enum(['product', 'service', 'callback', 'other']),
          summary: z.string(),
          items: z
            .array(
              z.object({
                name: z.string(),
                variant: z.string().optional(),
                price: z.number().optional(),
                qty: z.number().optional(),
              }),
            )
            .optional(),
          customer_name: z.string().optional(),
          phone: z.string().optional(),
        },
        hostQueuedHandler('create_local_order'),
        { annotations: HOST_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }
  if (allowed.has('submit_brief')) {
    tools.push(
      tool(
        'submit_brief',
        'Пресейл-бриф менеджеру. Closing text клієнту лишається в цій же відповіді.',
        {
          niche: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
          goal: z.string().optional(),
        },
        hostQueuedHandler('submit_brief'),
        { annotations: HOST_ANNOTATIONS, alwaysLoad: true },
      ),
    );
  }

  return createSdkMcpServer({
    name: CLAUDE_SDK_MCP_SERVER_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    tools,
  });
}

export const ALL_MCP_LOOKUP_TOOL_NAMES = LOOKUP_TOOL_NAMES.map(mcpLookupToolName);
export const ALL_MCP_PROFILE_TOOL_NAMES = PROFILE_TOOL_NAMES.map(
  (n) => `mcp__${CLAUDE_SDK_MCP_SERVER_NAME}__${n}`,
);
export const ALL_MCP_TERMINAL_TOOL_NAMES = TERMINAL_TOOL_NAMES.map(
  (n) => `mcp__${CLAUDE_SDK_MCP_SERVER_NAME}__${n}`,
);
