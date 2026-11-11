/**
 * Per-tenant CRM routing — which provider handles catalog, booking, orders, etc.
 *
 * Stored in settings.crm_routing (JSON). Env CRM_PROVIDER remains the fallback
 * when mode=single and no DB override exists. Target `none` = local-DB-only
 * (no vendor HTTP for that action).
 */

import { prisma } from './prisma.js';
import { config } from '../config.js';
import {
  isCrmProviderName,
  isCrmRouteTarget,
  type CrmAction,
  type CrmProviderName,
  type CrmRouteTarget,
} from './crm-providers.js';
import type { CrmAdapter } from '../services/crm/types.js';

export type CrmRoutingMode = 'single' | 'by_action' | 'prompt';

export interface CrmRoutingConfig {
  mode: CrmRoutingMode;
  default: CrmRouteTarget;
  enabled_providers: CrmProviderName[];
  routes: Partial<Record<CrmAction, CrmRouteTarget>>;
}

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

export function localOnlyCrmRouting(): CrmRoutingConfig {
  const routes = Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'none'])) as Record<
    CrmAction,
    CrmRouteTarget
  >;
  return {
    mode: 'single',
    default: 'none',
    enabled_providers: [],
    routes,
  };
}

/** True when tenant routing is fully local-DB-only. */
export function isCrmRoutingLocalOnly(routing: CrmRoutingConfig): boolean {
  if (routing.default === 'none' && routing.enabled_providers.length === 0) {
    return true;
  }
  return (
    routing.enabled_providers.length === 0 &&
    ALL_ACTIONS.every((a) => (routing.routes[a] ?? routing.default) === 'none')
  );
}

/** Unset routes follow the one default target. */
function routesForTarget(target: CrmRouteTarget): Record<CrmAction, CrmRouteTarget> {
  return Object.fromEntries(ALL_ACTIONS.map((action) => [action, target])) as Record<
    CrmAction,
    CrmRouteTarget
  >;
}

/**
 * Env CRM_PROVIDER → route target.
 * `none` / empty / unknown (except legacy fallback) → none when explicitly none;
 * unset defaults to keycrm for backward compat with env-only tenants that still
 * set KEYCRM_API_KEY without crm_routing row — ensureCrmRoutingAfterIntegrations
 * still flips to local-only when no credentials exist.
 */
function envDefaultTarget(): CrmRouteTarget {
  const raw = String(config.CRM_PROVIDER ?? 'keycrm').toLowerCase().trim();
  if (!raw || raw === 'none' || raw === 'off' || raw === 'local') return 'none';
  return isCrmProviderName(raw) ? raw : 'none';
}

/** Exported for unit tests. */
export function parseCrmRouting(raw: unknown): CrmRoutingConfig {
  const envDefault = envDefaultTarget();
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const mode: CrmRoutingMode =
    o.mode === 'by_action' || o.mode === 'prompt' ? o.mode : 'single';

  const defaultRaw = o.default !== undefined && o.default !== null ? String(o.default) : '';
  const defaultTarget: CrmRouteTarget = isCrmRouteTarget(defaultRaw)
    ? (defaultRaw as CrmRouteTarget)
    : envDefault;

  const enabledSpecified = Array.isArray(o.enabled_providers);
  const enabledRaw = enabledSpecified ? o.enabled_providers : [];
  const enabled = (enabledRaw as unknown[]).filter((p): p is CrmProviderName =>
    isCrmProviderName(String(p)),
  );

  // Missing enabled_providers: seed from default vendor (legacy). Explicit [] stays empty.
  if (!enabledSpecified && defaultTarget !== 'none') {
    enabled.push(defaultTarget);
    if (defaultTarget !== 'cleverbox' && config.CLEVERBOX_API_TOKEN) {
      enabled.push('cleverbox');
    }
  }

  const routesInput =
    o.routes && typeof o.routes === 'object' && !Array.isArray(o.routes)
      ? (o.routes as Record<string, unknown>)
      : {};

  const routes = routesForTarget(defaultTarget);
  for (const [action, provider] of Object.entries(routesInput)) {
    if (isCrmRouteTarget(String(provider))) {
      routes[action as CrmAction] = String(provider) as CrmRouteTarget;
    }
  }

  return {
    mode,
    default: defaultTarget,
    enabled_providers: [...new Set(enabled)],
    routes,
  };
}

export async function getCrmRouting(opts?: { fresh?: boolean }): Promise<CrmRoutingConfig> {
  if (!opts?.fresh && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const row = await prisma.setting.findUnique({ where: { key: 'crm_routing' } });
  _cache = parseCrmRouting(row?.value);
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
 * Pick CRM provider for a concrete action, or null when the route is `none`
 * / local-only (no vendor HTTP for this action).
 */
export async function resolveCrmProvider(
  action: CrmAction,
  opts: ResolveCrmProviderOptions = {},
): Promise<CrmProviderName | null> {
  const routing = await getCrmRouting();

  let chosen: CrmRouteTarget;

  if (routing.mode === 'prompt' && opts.toolProvider && isCrmProviderName(opts.toolProvider)) {
    chosen = opts.toolProvider;
  } else if (routing.mode === 'by_action' || routing.mode === 'prompt') {
    chosen = routing.routes[action] ?? routing.default;
  } else {
    chosen = routing.default;
  }

  if (chosen === 'none') return null;

  if (!isCrmProviderName(chosen)) return null;

  if (routing.enabled_providers.length === 0) {
    // Explicit empty catalog = local-only even if a stale route string remains.
    return null;
  }

  if (!routing.enabled_providers.includes(chosen)) {
    if (routing.default === 'none') return null;
    if (
      isCrmProviderName(routing.default) &&
      routing.enabled_providers.includes(routing.default)
    ) {
      return routing.default;
    }
    return null;
  }

  return chosen;
}

export type CrmForAction = {
  provider: CrmProviderName;
  adapter: CrmAdapter;
};

/**
 * Resolve provider + adapter for an action. Returns null when routing is
 * local-only OR the vendor has no credentials (avoids wasted HTTP).
 */
export async function getCrmForAction(
  action: CrmAction,
  opts: ResolveCrmProviderOptions = {},
): Promise<CrmForAction | null> {
  const provider = await resolveCrmProvider(action, opts);
  if (!provider) return null;

  const { getIntegrationConfig } = await import('./integration-config.js');
  const { providerReadCredentialsReason } = await import('./crm-write.js');
  const cfg = await getIntegrationConfig();
  if (providerReadCredentialsReason(provider, cfg)) return null;

  const { getCrmAdapter } = await import('../services/crm/registry.js');
  return { provider, adapter: getCrmAdapter(provider) };
}

export type CrmRoutingEnsureApplied = 'single_auto' | 'enabled_only' | 'local_only' | 'noop';

export interface CrmRoutingEnsureResult {
  applied: CrmRoutingEnsureApplied;
  config: CrmRoutingConfig;
  configuredProviders: CrmProviderName[];
}

export async function listConfiguredCrmProviders(): Promise<CrmProviderName[]> {
  // Lazy import avoids circular deps with integration-config → config
  const { getIntegrationConfig } = await import('./integration-config.js');
  const { providerHasCredentials } = await import('./crm-write.js');
  const cfg = await getIntegrationConfig({ fresh: true });
  const candidates: CrmProviderName[] = ['keycrm', 'cleverbox', 'beautypro', 'altegio'];
  return candidates.filter((p) => providerHasCredentials(p, cfg));
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
 * After integrations save: 0 CRM → local-only; exactly one → sole default;
 * two or more → ensure they appear in enabled_providers.
 */
export async function ensureCrmRoutingAfterIntegrations(): Promise<CrmRoutingEnsureResult> {
  const configuredProviders = await listConfiguredCrmProviders();
  const current = await getCrmRouting({ fresh: true });

  if (configuredProviders.length === 0) {
    const next = localOnlyCrmRouting();
    const same = isCrmRoutingLocalOnly(current);
    if (!same) {
      await persistCrmRouting(next);
    }
    return {
      applied: same ? 'noop' : 'local_only',
      config: same ? current : next,
      configuredProviders,
    };
  }

  if (configuredProviders.length === 1) {
    const p = configuredProviders[0]!;
    const routes = Object.fromEntries(ALL_ACTIONS.map((a) => [a, p])) as Record<
      CrmAction,
      CrmRouteTarget
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

  const enabled = [
    ...new Set([
      ...current.enabled_providers.filter((p) => configuredProviders.includes(p)),
      ...configuredProviders,
    ]),
  ];
  const needsUpdate =
    enabled.length !== current.enabled_providers.length ||
    configuredProviders.some((p) => !current.enabled_providers.includes(p)) ||
    current.default === 'none';
  if (!needsUpdate) {
    return { applied: 'noop', config: current, configuredProviders };
  }

  const defaultTarget: CrmRouteTarget =
    current.default !== 'none' && configuredProviders.includes(current.default as CrmProviderName)
      ? current.default
      : configuredProviders[0]!;

  const next: CrmRoutingConfig = {
    ...current,
    default: defaultTarget,
    enabled_providers: enabled,
    routes: { ...routesForTarget(defaultTarget), ...current.routes },
  };
  // Drop none-only stale routes that point at unconfigured vendors
  for (const a of ALL_ACTIONS) {
    const t = next.routes[a];
    if (t && t !== 'none' && !configuredProviders.includes(t)) {
      next.routes[a] = defaultTarget;
    }
  }
  await persistCrmRouting(next);
  return { applied: 'enabled_only', config: next, configuredProviders };
}
