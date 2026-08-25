/**
 * Shared readonly lookup executors (CLI text-protocol loop + SDK MCP).
 * CRM/catalog I/O stays in existing services — this file only formats results.
 */

import pino from 'pino';
import { isLookupToolName } from '../lib/tool-definitions.js';
import { fetchClientCrmHistory } from './client-crm-link.js';
import {
  executeGetAvailableSlotsTool,
  formatSearchServicesToolResult,
  parseSearchServicesLimit,
  searchServicesWithFallback,
} from './booking-lookup.js';
import { searchActiveProductsForContext } from './product-search.js';
import { getDeliveryCost } from './nova-poshta.js';

const log = pino({ name: 'agent-lookup-tools' });

export const MAX_LOOKUP_CONCURRENCY = 2;

export interface LookupToolContext {
  clientId?: string | null;
  branchCrmExternalId?: string | null;
  /** Booking mode + Client.crmBuyerId — required for get_client_crm_history. */
  crmHistoryAllowed?: boolean;
  clientMessage?: string;
  mutationsAllowed?: boolean;
  existingBooking?: { date: string; time: string } | null;
}

let lookupActive = 0;
const lookupWaiters: Array<() => void> = [];

export async function withLookupConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (lookupActive >= MAX_LOOKUP_CONCURRENCY) {
    await new Promise<void>((resolve) => lookupWaiters.push(resolve));
  }
  lookupActive += 1;
  try {
    return await fn();
  } finally {
    lookupActive -= 1;
    lookupWaiters.shift()?.();
  }
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

async function runSearchCatalog(args: Record<string, unknown>): Promise<string> {
  const query = asString(args.query);
  if (!query) return '[search_catalog] ПОМИЛКА: порожній запит';
  try {
    const { contextBlock, matchCount } = await searchActiveProductsForContext(query);
    return matchCount > 0
      ? `[search_catalog] РЕЗУЛЬТАТ:\n${contextBlock}`
      : `[search_catalog] Нічого не знайдено за «${query}». Уточни у клієнта назву/модель або запропонуй схожі з каталогу.`;
  } catch (err) {
    log.error({ err, query }, 'search_catalog failed');
    return '[search_catalog] ПОМИЛКА: каталог тимчасово недоступний. Відповідай за знімком каталогу в промпті.';
  }
}

async function runDeliveryCost(args: Record<string, unknown>): Promise<string> {
  const city = asString(args.city);
  if (!city) return '[get_delivery_cost] ПОМИЛКА: місто не вказано';
  const weightKg =
    typeof args.weight_kg === 'number' && Number.isFinite(args.weight_kg)
      ? args.weight_kg
      : 0.5;
  const declaredValue =
    typeof args.declared_value === 'number' && Number.isFinite(args.declared_value)
      ? args.declared_value
      : 500;
  try {
    const npResult = await getDeliveryCost(city, weightKg, declaredValue);
    if ('error' in npResult) {
      return `[get_delivery_cost] ПОМИЛКА: ${npResult.error}`;
    }
    return `[get_delivery_cost] РЕЗУЛЬТАТ: Місто "${npResult.recipientCityName}", доставка НП (${npResult.serviceType}): ${npResult.cost} грн`;
  } catch (err) {
    log.error({ err, city }, 'get_delivery_cost failed');
    return '[get_delivery_cost] ПОМИЛКА: сервіс тимчасово недоступний';
  }
}

async function runSearchServices(
  args: Record<string, unknown>,
  ctx: LookupToolContext,
): Promise<string> {
  const query = asString(args.query);
  if (!query) return '[search_services] ПОМИЛКА: порожній запит';
  try {
    const found = await searchServicesWithFallback(query, parseSearchServicesLimit(args), {
      clientMessage: ctx.clientMessage,
    });
    return formatSearchServicesToolResult({
      query,
      matchCount: found.matchCount,
      contextBlock: found.contextBlock,
      usedQuery: found.usedQuery,
      broadenedFrom: found.broadenedFrom,
      intentNote: found.intentNote,
    });
  } catch (err) {
    log.error({ err, query }, 'search_services failed');
    return '[search_services] ПОМИЛКА: CRM тимчасово недоступна.';
  }
}

async function runCrmHistory(
  args: Record<string, unknown>,
  ctx: LookupToolContext,
): Promise<string> {
  if (!ctx.crmHistoryAllowed || !ctx.clientId) {
    return '[get_client_crm_history] ПОМИЛКА: історія доступна лише для привʼязаного CRM-клієнта в режимі запису.';
  }
  try {
    const serviceId = asString(args.service_id) || undefined;
    const serviceName = asString(args.service_query) || undefined;
    const catalogDurationMin =
      typeof args.duration_min === 'number' && Number.isFinite(args.duration_min)
        ? args.duration_min
        : undefined;
    const masterId = asString(args.master_id) || undefined;
    const history = await fetchClientCrmHistory(ctx.clientId, {
      limit: 10,
      serviceId,
      serviceName,
      catalogDurationMin,
      masterId,
    });
    return `[get_client_crm_history] РЕЗУЛЬТАТ:\n${history.text}`;
  } catch (err) {
    log.error({ err, clientId: ctx.clientId }, 'get_client_crm_history failed');
    return '[get_client_crm_history] ПОМИЛКА: не вдалося отримати історію CRM';
  }
}

/**
 * Execute one readonly lookup. Safe to call from conversation.ts or MCP.
 */
export async function executeLookupTool(
  name: string,
  args: Record<string, unknown>,
  ctx: LookupToolContext = {},
): Promise<string> {
  return withLookupConcurrencyLimit(async () => {
    switch (name) {
      case 'search_catalog':
        return runSearchCatalog(args);
      case 'get_delivery_cost':
        return runDeliveryCost(args);
      case 'search_services':
        return runSearchServices(args, ctx);
      case 'get_available_slots':
        return executeGetAvailableSlotsTool({
          args,
          branchCrmExternalId: ctx.branchCrmExternalId,
          clientId: ctx.clientId,
        });
      case 'get_client_crm_history':
        return runCrmHistory(args, ctx);
      default:
        if (!isLookupToolName(name)) {
          return `[${name}] ПОМИЛКА: не lookup tool`;
        }
        return `[${name}] ПОМИЛКА: невідомий lookup`;
    }
  });
}

export function lookupResultFromResponse(
  results: { name: string; result: string }[] | undefined,
  name: string,
): string | undefined {
  return results?.find((r) => r.name === name)?.result;
}

/** True when SDK already executed this lookup in-process (skip host Claude replay). */
export function hasNativeLookupResult(
  results: { name: string; result: string }[] | undefined,
  name: string,
): boolean {
  const result = lookupResultFromResponse(results, name);
  if (!result?.trim()) return false;
  return !/HOST_QUEUED/i.test(result);
}
