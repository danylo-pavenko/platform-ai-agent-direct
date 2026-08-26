/**
 * Booking lookup helpers: service search with ranking + slots tool execution.
 */

import {
  formatSearchServicesToolResult,
  parseGetAvailableSlotsArgs,
} from '../lib/booking-lookup-format.js';
import { clampServiceSearchLimit } from '../lib/service-search-rank.js';
import { getAvailableSlotsForContext, searchServicesForContext } from './service-search.js';
import { resolveBookingBranchCrmId } from './booking-branch.js';

export {
  broadenServiceQueries,
  formatSearchServicesToolResult,
  parseGetAvailableSlotsArgs,
} from '../lib/booking-lookup-format.js';

/**
 * Ranked service search (snapshot → live). Query variants are expanded inside
 * searchServicesForContext — no extra CRM round-trips for broaden.
 */
export async function searchServicesWithFallback(
  query: string,
  limit?: number,
  opts?: { clientMessage?: string },
): Promise<{
  contextBlock: string;
  matchCount: number;
  usedQuery: string;
  broadenedFrom?: string;
  clientIntentQuery?: string;
  intentNote?: string;
}> {
  return searchServicesForContext(query, clampServiceSearchLimit(limit), opts);
}

export async function executeGetAvailableSlotsTool(params: {
  args: Record<string, unknown>;
  branchCrmExternalId?: string | null;
  clientId?: string | null;
  timeZone?: string | null;
}): Promise<string> {
  const parsed = parseGetAvailableSlotsArgs(params.args);
  if ('error' in parsed) return parsed.error;

  const branchCrmId = await resolveBookingBranchCrmId(params.branchCrmExternalId);
  if (!branchCrmId) {
    return (
      '[get_available_slots] ПОМИЛКА: немає філії/локації CRM. ' +
      'Обери філію через set_conversation_branch або налаштуй default location.'
    );
  }

  try {
    const slotsText = await getAvailableSlotsForContext({
      date: parsed.date,
      branchCrmId,
      services: parsed.services,
      fullMonth: parsed.fullMonth,
      masterId: parsed.masterId,
      clientId: params.clientId,
      timeZone: params.timeZone,
    });
    return `[get_available_slots] РЕЗУЛЬТАТ:\n${slotsText}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `[get_available_slots] ПОМИЛКА: не вдалося отримати слоти — ${detail.slice(0, 280)}`;
  }
}

/** Parse optional search_services.limit from tool args. */
export function parseSearchServicesLimit(args: Record<string, unknown>): number | undefined {
  const raw = args.limit;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return clampServiceSearchLimit(n);
}
