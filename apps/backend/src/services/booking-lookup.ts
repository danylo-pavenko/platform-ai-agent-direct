/**
 * Booking lookup helpers: broaden empty service queries and execute slots tool.
 */

import {
  broadenServiceQueries,
  formatSearchServicesToolResult,
  parseGetAvailableSlotsArgs,
} from '../lib/booking-lookup-format.js';
import { getAvailableSlotsForContext, searchServicesForContext } from './service-search.js';
import { resolveBookingBranchCrmId } from './booking-branch.js';

export {
  broadenServiceQueries,
  formatSearchServicesToolResult,
  parseGetAvailableSlotsArgs,
} from '../lib/booking-lookup-format.js';

export async function searchServicesWithFallback(query: string): Promise<{
  contextBlock: string;
  matchCount: number;
  usedQuery: string;
  broadenedFrom?: string;
}> {
  const primary = await searchServicesForContext(query);
  if (primary.matchCount > 0) {
    return {
      contextBlock: primary.contextBlock,
      matchCount: primary.matchCount,
      usedQuery: query,
    };
  }

  for (const alt of broadenServiceQueries(query)) {
    const retry = await searchServicesForContext(alt);
    if (retry.matchCount > 0) {
      return {
        contextBlock: retry.contextBlock,
        matchCount: retry.matchCount,
        usedQuery: alt,
        broadenedFrom: query,
      };
    }
  }

  return {
    contextBlock: '',
    matchCount: 0,
    usedQuery: query,
  };
}

export async function executeGetAvailableSlotsTool(params: {
  args: Record<string, unknown>;
  branchCrmExternalId?: string | null;
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
    });
    return `[get_available_slots] РЕЗУЛЬТАТ:\n${slotsText}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `[get_available_slots] ПОМИЛКА: не вдалося отримати слоти — ${detail.slice(0, 280)}`;
  }
}
