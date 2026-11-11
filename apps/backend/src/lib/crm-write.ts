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
import { CRM_NOT_CONNECTED_LABEL, providerDisplayName } from './crm-providers.js';
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
  provider?: CrmProviderName | null;
}

type IntegrationCreds = Pick<IntegrationConfig, 'keycrm' | 'cleverbox' | 'beautypro' | 'altegio'>;

/**
 * Structural credentials present (integration plugged in).
 * Does not treat BeautyPro Marketplace pending as "missing" — tenant still has CRM.
 */
export function providerHasCredentials(
  provider: CrmProviderName,
  cfg: IntegrationCreds,
): boolean {
  if (provider === 'keycrm') return Boolean(cfg.keycrm.apiKey);
  if (provider === 'cleverbox') return Boolean(cfg.cleverbox.apiToken);
  if (provider === 'beautypro') {
    return Boolean(
      cfg.beautypro.applicationId &&
        cfg.beautypro.applicationSecret &&
        cfg.beautypro.databaseCode,
    );
  }
  if (provider === 'altegio') {
    return Boolean(cfg.altegio.partnerToken && cfg.altegio.userToken && cfg.altegio.locationId);
  }
  return false;
}

/** Missing-credential reason for writes, or null when the provider can accept writes. */
export function providerWriteCredentialsReason(
  provider: CrmProviderName,
  cfg: IntegrationCreds,
): string | null {
  if (!providerHasCredentials(provider, cfg)) {
    if (provider === 'keycrm') return 'API ключ KeyCRM не налаштовано';
    if (provider === 'cleverbox') return 'Токен CleverBOX не налаштовано';
    if (provider === 'beautypro') {
      return 'BeautyPro: application_id, secret або database_code не налаштовано';
    }
    if (provider === 'altegio') {
      return 'Altegio: partner token, user token або location id не налаштовано';
    }
    return `${providerDisplayName(provider)} не налаштовано`;
  }
  if (provider === 'beautypro') {
    if (cfg.beautypro.authStatus === 'pending') {
      return 'BeautyPro очікує Grant access у Marketplace';
    }
    if (cfg.beautypro.authStatus === 'refused') {
      return 'BeautyPro: доступ відхилено';
    }
  }
  return null;
}

/**
 * Reason why live CRM HTTP should not run (reads + writes).
 * Same as write for vendors; used by getCrmForAction short-circuit.
 */
export function providerReadCredentialsReason(
  provider: CrmProviderName,
  cfg: IntegrationCreds,
): string | null {
  return providerWriteCredentialsReason(provider, cfg);
}

/**
 * True when writes are enabled AND the CRM for this action has credentials.
 * Default action is `order` — dashboard / health keep that meaning.
 */
export async function isCrmWriteReady(
  action: CrmAction = 'order',
): Promise<CrmWriteReadyResult> {
  const envEnabled = config.CRM_WRITE_ENABLED;
  const settingsEnabled = envEnabled ? false : await isCrmWriteEnabledInSettings();
  const enabled = envEnabled || settingsEnabled;
  const provider = await resolveCrmProvider(action);

  if (!provider) {
    return {
      ready: false,
      enabled,
      source: enabled ? (envEnabled ? 'env' : 'settings') : 'none',
      provider: null,
      reason: CRM_NOT_CONNECTED_LABEL,
    };
  }

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
