/**
 * CRM write gating — env master switch OR tenant Settings toggle.
 *
 * Read path (catalog sync, search_products) only needs an API key.
 * Write path (mirror client/order/brief) additionally requires an
 * explicit enable flag so new tenants stay local-DB-only by default.
 */

import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { resolveCrmProvider } from './crm-routing.js';
import type { CrmAction, CrmProviderName } from './crm-providers.js';
import { providerDisplayName } from './crm-providers.js';
import { getIntegrationConfig, type IntegrationConfig } from './integration-config.js';

const CACHE_TTL_MS = 60_000;

let featureFlagsCache: { crmWriteEnabled: boolean; expiresAt: number } | null = null;

export function invalidateCrmWriteCache(): void {
  featureFlagsCache = null;
}

async function isCrmWriteEnabledInSettings(): Promise<boolean> {
  const now = Date.now();
  if (featureFlagsCache && featureFlagsCache.expiresAt > now) {
    return featureFlagsCache.crmWriteEnabled;
  }

  const row = await prisma.setting.findUnique({ where: { key: 'feature_flags' } });
  const flags = (row?.value ?? {}) as { crm_write_enabled?: boolean };
  const enabled = flags.crm_write_enabled === true;
  featureFlagsCache = { crmWriteEnabled: enabled, expiresAt: now + CACHE_TTL_MS };
  return enabled;
}

/** True when CRM order/client writes are allowed (env OR Settings). */
export async function isCrmWriteEnabled(): Promise<boolean> {
  if (config.CRM_WRITE_ENABLED) return true;
  return isCrmWriteEnabledInSettings();
}

export type CrmWriteSource = 'env' | 'settings' | 'none';

export interface CrmWriteReadyResult {
  ready: boolean;
  enabled: boolean;
  source: CrmWriteSource;
  reason?: string;
  provider?: CrmProviderName;
}

type IntegrationCreds = Pick<IntegrationConfig, 'keycrm' | 'cleverbox' | 'beautypro'>;

/** Missing-credential reason, or null when the provider can accept writes. */
export function providerWriteCredentialsReason(
  provider: CrmProviderName,
  cfg: IntegrationCreds,
): string | null {
  if (provider === 'keycrm') {
    return cfg.keycrm.apiKey ? null : 'API ключ KeyCRM не налаштовано';
  }
  if (provider === 'cleverbox') {
    return cfg.cleverbox.apiToken ? null : 'Токен CleverBOX не налаштовано';
  }
  if (provider === 'beautypro') {
    if (
      !cfg.beautypro.applicationId
      || !cfg.beautypro.applicationSecret
      || !cfg.beautypro.databaseCode
    ) {
      return 'BeautyPro: application_id, secret або database_code не налаштовано';
    }
    if (cfg.beautypro.authStatus === 'pending') {
      return 'BeautyPro очікує Grant access у Marketplace';
    }
    if (cfg.beautypro.authStatus === 'refused') {
      return 'BeautyPro: доступ відхилено';
    }
    return null;
  }
  return `${providerDisplayName(provider)} не налаштовано`;
}

/**
 * True when writes are enabled AND the CRM for this action has credentials.
 * Default action is `order` (KeyCRM) — dashboard / health keep that meaning.
 */
export async function isCrmWriteReady(
  action: CrmAction = 'order',
): Promise<CrmWriteReadyResult> {
  const envEnabled = config.CRM_WRITE_ENABLED;
  const settingsEnabled = envEnabled ? false : await isCrmWriteEnabledInSettings();
  const enabled = envEnabled || settingsEnabled;
  const provider = await resolveCrmProvider(action);

  if (!enabled) {
    return {
      ready: false,
      enabled: false,
      source: 'none',
      provider,
      reason: 'Запис у CRM вимкнено (.env або Налаштування)',
    };
  }

  const cfg = await getIntegrationConfig();
  const credsReason = providerWriteCredentialsReason(provider, cfg);
  const source: CrmWriteSource = envEnabled ? 'env' : 'settings';
  if (credsReason) {
    return {
      ready: false,
      enabled: true,
      source,
      provider,
      reason: credsReason,
    };
  }

  return {
    ready: true,
    enabled: true,
    source,
    provider,
  };
}
