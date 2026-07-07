/**
 * Per-tenant CRM routing — which provider handles catalog, booking, orders, etc.
 *
 * Stored in settings.crm_routing (JSON). Env CRM_PROVIDER remains the fallback
 * when mode=single and no DB override exists.
 */

import { prisma } from './prisma.js';
import { config } from '../config.js';
import {
  isCrmProviderName,
  type CrmAction,
  type CrmProviderName,
} from './crm-providers.js';

export type CrmRoutingMode = 'single' | 'by_action' | 'prompt';

export interface CrmRoutingConfig {
  mode: CrmRoutingMode;
  default: CrmProviderName;
  enabled_providers: CrmProviderName[];
  routes: Partial<Record<CrmAction, CrmProviderName>>;
}

const DEFAULT_ROUTES: Record<CrmAction, CrmProviderName> = {
  catalog: 'keycrm',
  services: 'cleverbox',
  branches: 'cleverbox',
  order: 'keycrm',
  lead: 'keycrm',
  booking: 'cleverbox',
  client_upsert: 'keycrm',
};

let _cache: CrmRoutingConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function envDefaultProvider(): CrmProviderName {
  const raw = (config.CRM_PROVIDER ?? 'keycrm').toLowerCase();
  return isCrmProviderName(raw) ? raw : 'keycrm';
}

function parseRouting(raw: unknown): CrmRoutingConfig {
  const envDefault = envDefaultProvider();
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const mode: CrmRoutingMode =
    o.mode === 'by_action' || o.mode === 'prompt' ? o.mode : 'single';

  const defaultProvider = isCrmProviderName(String(o.default ?? ''))
    ? (o.default as CrmProviderName)
    : envDefault;

  const enabledRaw = Array.isArray(o.enabled_providers) ? o.enabled_providers : [];
  const enabled = enabledRaw.filter((p): p is CrmProviderName =>
    isCrmProviderName(String(p)),
  );
  if (enabled.length === 0) {
    enabled.push(defaultProvider);
    if (defaultProvider !== 'cleverbox' && config.CLEVERBOX_API_TOKEN) {
      enabled.push('cleverbox');
    }
  }

  const routesInput =
    o.routes && typeof o.routes === 'object' && !Array.isArray(o.routes)
      ? (o.routes as Record<string, unknown>)
      : {};

  const routes = { ...DEFAULT_ROUTES };
  for (const [action, provider] of Object.entries(routesInput)) {
    if (isCrmProviderName(String(provider))) {
      routes[action as CrmAction] = provider as CrmProviderName;
    }
  }

  return { mode, default: defaultProvider, enabled_providers: [...new Set(enabled)], routes };
}

export async function getCrmRouting(opts?: { fresh?: boolean }): Promise<CrmRoutingConfig> {
  if (!opts?.fresh && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const row = await prisma.setting.findUnique({ where: { key: 'crm_routing' } });
  _cache = parseRouting(row?.value);
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateCrmRoutingCache(): void {
  _cache = null;
  _cacheAt = 0;
}

export interface ResolveCrmProviderOptions {
  /** Agent tool arg when mode=prompt */
  toolProvider?: string;
}

/**
 * Pick CRM provider for a concrete action. Validates against enabled_providers.
 */
export async function resolveCrmProvider(
  action: CrmAction,
  opts: ResolveCrmProviderOptions = {},
): Promise<CrmProviderName> {
  const routing = await getCrmRouting();

  let chosen: CrmProviderName;

  if (routing.mode === 'prompt' && opts.toolProvider && isCrmProviderName(opts.toolProvider)) {
    chosen = opts.toolProvider;
  } else if (routing.mode === 'by_action' || routing.mode === 'prompt') {
    chosen = routing.routes[action] ?? routing.default;
  } else {
    chosen = routing.default;
  }

  if (!routing.enabled_providers.includes(chosen)) {
    chosen = routing.default;
  }

  return chosen;
}
