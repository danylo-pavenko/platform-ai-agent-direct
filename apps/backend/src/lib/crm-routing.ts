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

const ALL_ACTIONS: CrmAction[] = [
  'catalog',
  'services',
  'branches',
  'order',
  'lead',
  'booking',
  'client_upsert',
];

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

export type CrmRoutingEnsureApplied = 'single_auto' | 'enabled_only' | 'noop';

export interface CrmRoutingEnsureResult {
  applied: CrmRoutingEnsureApplied;
  config: CrmRoutingConfig;
  configuredProviders: CrmProviderName[];
}

async function listConfiguredCrmProviders(): Promise<CrmProviderName[]> {
  // Lazy import avoids circular deps with integration-config → config
  const { getIntegrationConfig } = await import('./integration-config.js');
  const cfg = await getIntegrationConfig({ fresh: true });
  const out: CrmProviderName[] = [];
  if (cfg.keycrm.apiKey) out.push('keycrm');
  if (cfg.cleverbox.apiToken) out.push('cleverbox');
  if (
    cfg.beautypro.applicationId &&
    cfg.beautypro.applicationSecret &&
    cfg.beautypro.databaseCode
  ) {
    out.push('beautypro');
  }
  return out;
}

async function persistCrmRouting(next: CrmRoutingConfig): Promise<void> {
  await prisma.setting.upsert({
    where: { key: 'crm_routing' },
    create: { key: 'crm_routing', value: next as never },
    update: { value: next as never },
  });
  invalidateCrmRoutingCache();
}

/**
 * After integrations save: if exactly one CRM is configured → make it the sole
 * default for all actions. If two or more → only ensure they appear in
 * enabled_providers (routes/default left for manual hybrid setup).
 */
export async function ensureCrmRoutingAfterIntegrations(): Promise<CrmRoutingEnsureResult> {
  const configuredProviders = await listConfiguredCrmProviders();
  const current = await getCrmRouting({ fresh: true });

  if (configuredProviders.length === 0) {
    return { applied: 'noop', config: current, configuredProviders };
  }

  if (configuredProviders.length === 1) {
    const p = configuredProviders[0]!;
    const routes = Object.fromEntries(ALL_ACTIONS.map((a) => [a, p])) as Record<
      CrmAction,
      CrmProviderName
    >;
    const next: CrmRoutingConfig = {
      mode: 'single',
      default: p,
      enabled_providers: [p],
      routes,
    };
    const same =
      current.mode === 'single' &&
      current.default === p &&
      current.enabled_providers.length === 1 &&
      current.enabled_providers[0] === p &&
      ALL_ACTIONS.every((a) => (current.routes[a] ?? current.default) === p);
    if (!same) {
      await persistCrmRouting(next);
    }
    return {
      applied: same ? 'noop' : 'single_auto',
      config: same ? current : next,
      configuredProviders,
    };
  }

  const enabled = [...new Set([...current.enabled_providers, ...configuredProviders])];
  const needsUpdate =
    enabled.length !== current.enabled_providers.length ||
    configuredProviders.some((p) => !current.enabled_providers.includes(p));
  if (!needsUpdate) {
    return { applied: 'noop', config: current, configuredProviders };
  }

  const next: CrmRoutingConfig = {
    ...current,
    enabled_providers: enabled,
    routes: { ...DEFAULT_ROUTES, ...current.routes },
  };
  await persistCrmRouting(next);
  return { applied: 'enabled_only', config: next, configuredProviders };
}
