/**
 * Sandbox tool execution — read CRM tools only (no real bookings).
 */
import pino from 'pino';
import type { ToolDefinition } from './claude.js';
import { resolveBookingBranchCrmId } from './booking-branch.js';
import {
  getAvailableSlotsForContext,
  searchServicesForContext,
} from './service-search.js';

const log = pino({ name: 'sandbox-tools' });

const MAX_TOOL_ROUNDS = 4;

type ToolCall = { name: string; args: Record<string, unknown> };

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

export async function executeSandboxToolCall(tc: ToolCall): Promise<string> {
  switch (tc.name) {
    case 'search_services': {
      const query = asString(tc.args.query);
      if (!query) return '[search_services] ПОМИЛКА: порожній запит';
      try {
        const { contextBlock, matchCount } = await searchServicesForContext(query);
        return matchCount > 0
          ? `[search_services] РЕЗУЛЬТАТ:\n${contextBlock}`
          : `[search_services] Нічого не знайдено за «${query}».`;
      } catch (err) {
        log.error({ err, query }, 'sandbox search_services failed');
        return '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
      }
    }

    case 'get_available_slots': {
      const date = asString(tc.args.date);
      const rawServices = Array.isArray(tc.args.services) ? tc.args.services : [];
      const services = rawServices.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const o = raw as Record<string, unknown>;
        const id = asString(o.id);
        const durationMin =
          typeof o.duration_min === 'number' ? o.duration_min : Number(o.duration_min) || 60;
        if (!id) return [];
        return [{ id, durationMin }];
      });
      if (!date || services.length === 0) {
        return '[get_available_slots] ПОМИЛКА: потрібні date та services';
      }
      const branchCrmId = await resolveBookingBranchCrmId(null);
      if (!branchCrmId) {
        return '[get_available_slots] ПОМИЛКА: немає філії/локації CRM (налаштуй default location або філію).';
      }
      try {
        const masterId = asString(tc.args.master_id) || undefined;
        const slotsText = await getAvailableSlotsForContext({
          date,
          branchCrmId,
          services,
          fullMonth: tc.args.full_month === true,
          masterId,
        });
        return `[get_available_slots] РЕЗУЛЬТАТ:\n${slotsText}`;
      } catch (err) {
        log.error({ err, date }, 'sandbox get_available_slots failed');
        return '[get_available_slots] ПОМИЛКА: не вдалося отримати слоти';
      }
    }

    case 'get_client_crm_history':
      return (
        '[get_client_crm_history] Пісочниця: історії тестового клієнта немає. ' +
        'Працюй як з новою клієнткою (slots без master_id).'
      );

    case 'book_appointment':
      return (
        '[book_appointment] Пісочниця: реальний запис у CRM НЕ створюється. ' +
        'Підтвердь клієнтці слот текстом так, ніби запис успішний (для тесту діалогу).'
      );

    case 'update_client_info':
      return '[update_client_info] Пісочниця: контакти збережено локально для тесту (OK).';

    case 'create_local_order':
      return '[create_local_order] Пісочниця: заявку зафіксовано для тесту (OK, без Telegram).';

    case 'request_handoff':
      return '[request_handoff] Пісочниця: handoff позначено (OK, без Telegram).';

    case 'set_conversation_branch':
      return '[set_conversation_branch] Пісочниця: філію прийнято (для слотів використовується default location).';

    case 'tag_client':
    case 'classify_intent':
    case 'attach_reference_photo':
      return `[${tc.name}] Пісочниця: OK`;

    default:
      return `[${tc.name}] Пісочниця: tool не виконується тут.`;
  }
}

/**
 * Prefer one read tool per round (services before slots), matching production order.
 */
export function pickSandboxToolCall(toolCalls: ToolCall[]): ToolCall | null {
  if (!toolCalls.length) return null;
  const priority = [
    'search_services',
    'get_available_slots',
    'get_client_crm_history',
    'update_client_info',
    'book_appointment',
    'create_local_order',
    'request_handoff',
  ];
  for (const name of priority) {
    const hit = toolCalls.find((tc) => tc.name === name);
    if (hit) return hit;
  }
  return toolCalls[0] ?? null;
}

export { MAX_TOOL_ROUNDS };
export type { ToolCall, ToolDefinition };
