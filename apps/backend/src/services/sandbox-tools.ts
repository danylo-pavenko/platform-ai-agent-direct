/**
 * Sandbox tool execution — live CRM/catalog reads; writes are dry-run only.
 */
import pino from 'pino';
import { resolveBookingBranchCrmId } from './booking-branch.js';
import {
  getAvailableSlotsForContext,
  searchServicesForContext,
} from './service-search.js';
import { parseSearchServicesLimit } from './booking-lookup.js';
import { formatSearchServicesToolResult, parseGetAvailableSlotsArgs } from '../lib/booking-lookup-format.js';
import { searchActiveProductsForContext } from './product-search.js';
import { getDeliveryCost } from './nova-poshta.js';
import { getAgentConfig } from '../lib/agent-config.js';

const log = pino({ name: 'sandbox-tools' });

export const MAX_TOOL_ROUNDS = 4;

export type ToolCall = { name: string; args: Record<string, unknown> };

export type SandboxToolDebugEntry = {
  name: string;
  args: Record<string, unknown>;
  resultPreview: string;
  dryRun?: boolean;
};

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function preview(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export async function executeSandboxToolCall(tc: ToolCall): Promise<{
  content: string;
  dryRun?: boolean;
}> {
  switch (tc.name) {
    case 'search_services': {
      const query = asString(tc.args.query);
      if (!query) return { content: '[search_services] ПОМИЛКА: порожній запит' };
      try {
        const found = await searchServicesForContext(
          query,
          parseSearchServicesLimit(tc.args),
        );
        return {
          content: formatSearchServicesToolResult({
            query,
            matchCount: found.matchCount,
            contextBlock: found.contextBlock,
            usedQuery: found.usedQuery,
            broadenedFrom: found.broadenedFrom,
          }),
        };
      } catch (err) {
        log.error({ err, query }, 'sandbox search_services failed');
        return { content: '[search_services] ПОМИЛКА: CRM тимчасово недоступна.' };
      }
    }

    case 'search_catalog': {
      const query = asString(tc.args.query);
      if (!query) return { content: '[search_catalog] ПОМИЛКА: порожній запит' };
      try {
        const { contextBlock, matchCount } = await searchActiveProductsForContext(query);
        return {
          content:
            matchCount > 0
              ? `[search_catalog] РЕЗУЛЬТАТ:\n${contextBlock}`
              : `[search_catalog] Нічого не знайдено за «${query}».`,
        };
      } catch (err) {
        log.error({ err, query }, 'sandbox search_catalog failed');
        return {
          content:
            '[search_catalog] ПОМИЛКА: каталог тимчасово недоступний. Відповідай за знімком у промпті.',
        };
      }
    }

    case 'get_delivery_cost': {
      const city = asString(tc.args.city);
      if (!city) return { content: '[get_delivery_cost] ПОМИЛКА: потрібен city' };
      const weightKg =
        typeof tc.args.weight_kg === 'number'
          ? tc.args.weight_kg
          : Number(tc.args.weight_kg) || 1;
      const declaredValue =
        typeof tc.args.declared_value === 'number'
          ? tc.args.declared_value
          : Number(tc.args.declared_value) || 500;
      try {
        const np = await getDeliveryCost(city, weightKg, declaredValue);
        return {
          content: `[get_delivery_cost] РЕЗУЛЬТАТ:\n${JSON.stringify(np, null, 2)}`,
        };
      } catch (err) {
        log.error({ err, city }, 'sandbox get_delivery_cost failed');
        return { content: '[get_delivery_cost] ПОМИЛКА: Nova Poshta недоступна.' };
      }
    }

    case 'get_available_slots': {
      const parsed = parseGetAvailableSlotsArgs(tc.args);
      if ('error' in parsed) {
        return { content: parsed.error };
      }
      const branchCrmId = await resolveBookingBranchCrmId(null);
      if (!branchCrmId) {
        return {
          content:
            '[get_available_slots] ПОМИЛКА: немає філії/локації CRM (налаштуй default location або філію).',
        };
      }
      try {
        const agentCfg = await getAgentConfig();
        const slotsText = await getAvailableSlotsForContext({
          date: parsed.date,
          branchCrmId,
          services: parsed.services,
          fullMonth: parsed.fullMonth,
          masterId: parsed.masterId,
          timeZone: agentCfg.timezone,
        });
        return { content: `[get_available_slots] РЕЗУЛЬТАТ:\n${slotsText}` };
      } catch (err) {
        log.error({ err, date: parsed.date }, 'sandbox get_available_slots failed');
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: `[get_available_slots] ПОМИЛКА: не вдалося отримати слоти — ${detail.slice(0, 280)}`,
        };
      }
    }

    case 'get_client_crm_history':
      return {
        content:
          '[get_client_crm_history] Пісочниця: використай runtime-блок історії з обраної персони (якщо є). ' +
          'Окремого CRM buyer у sandbox немає.',
      };

    case 'book_appointment':
      return {
        dryRun: true,
        content:
          `[book_appointment] DRY-RUN (CRM не змінено).\n` +
          `Payload preview:\n${JSON.stringify(tc.args, null, 2)}\n` +
          `Підтвердь клієнтці слот текстом так, ніби запис успішний.`,
      };

    case 'cancel_appointment':
    case 'remove_appointment_service':
    case 'reschedule_appointment':
      return {
        dryRun: true,
        content:
          `[${tc.name}] DRY-RUN (CRM не змінено).\n` +
          `Payload preview:\n${JSON.stringify(tc.args, null, 2)}`,
      };

    case 'collect_order':
    case 'create_local_order':
      return {
        dryRun: true,
        content:
          `[${tc.name}] DRY-RUN (замовлення/Telegram не створено).\n` +
          `Payload preview:\n${JSON.stringify(tc.args, null, 2)}`,
      };

    case 'update_client_info':
      return {
        dryRun: true,
        content: `[update_client_info] DRY-RUN: контакти прийнято для тесту.\n${JSON.stringify(tc.args, null, 2)}`,
      };

    case 'request_handoff':
      return {
        dryRun: true,
        content: `[request_handoff] DRY-RUN: handoff позначено (без Telegram).\n${JSON.stringify(tc.args, null, 2)}`,
      };

    case 'set_conversation_branch':
      return {
        dryRun: true,
        content:
          '[set_conversation_branch] DRY-RUN: філію прийнято (слоти все одно через default location).',
      };

    case 'tag_client':
    case 'classify_intent':
    case 'attach_reference_photo':
    case 'submit_brief':
      return { dryRun: true, content: `[${tc.name}] DRY-RUN: OK` };

    default:
      return { content: `[${tc.name}] Пісочниця: tool не виконується тут.` };
  }
}

/**
 * Prefer one read tool per round (catalog/services before slots), matching production order.
 */
export function pickSandboxToolCall(toolCalls: ToolCall[]): ToolCall | null {
  if (!toolCalls.length) return null;
  const priority = [
    'search_catalog',
    'search_services',
    'get_delivery_cost',
    'get_available_slots',
    'get_client_crm_history',
    'update_client_info',
    'book_appointment',
    'cancel_appointment',
    'remove_appointment_service',
    'reschedule_appointment',
    'collect_order',
    'create_local_order',
    'submit_brief',
    'request_handoff',
  ];
  for (const name of priority) {
    const hit = toolCalls.find((tc) => tc.name === name);
    if (hit) return hit;
  }
  return toolCalls[0] ?? null;
}

export function stageLabelForTool(name: string): string {
  switch (name) {
    case 'search_services':
      return 'Шукаю послуги…';
    case 'search_catalog':
      return 'Шукаю в каталозі…';
    case 'get_available_slots':
      return 'Дивлюсь вільні вікна…';
    case 'get_delivery_cost':
      return 'Рахую доставку…';
    case 'get_client_crm_history':
      return 'Дивлюсь історію клієнта…';
    case 'book_appointment':
      return 'Готую запис (dry-run)…';
    case 'cancel_appointment':
      return 'Скасовую запис (dry-run)…';
    case 'remove_appointment_service':
      return 'Прибираю послугу (dry-run)…';
    case 'reschedule_appointment':
      return 'Переношу запис (dry-run)…';
    case 'collect_order':
    case 'create_local_order':
      return 'Готую замовлення (dry-run)…';
    default:
      return `Виконую ${name}…`;
  }
}

export function buildReturningPersonaHistory(): string {
  return [
    'CRM історія візитів (тривалість + улюблений майстер для запису):',
    '- 10.07.2026 | 60 хв | Чоловічий манікюр | майстер: Оля [master_id=sandbox-master-olya]',
    'Орієнтир: остання тривалість 60 хв, середня з історії ~60 хв — враховуй при виборі слота.',
    'Улюблений майстер: Оля [master_id=sandbox-master-olya] — лише для схожої послуги з історії. Інша категорія — не підставляй цей id. Клієнту показуй лише ім\'я, не id.',
  ].join('\n');
}

export { preview as previewToolResult };
