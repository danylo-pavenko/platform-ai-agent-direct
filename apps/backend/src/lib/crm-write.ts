/**
 * CRM write gating — env master switch OR tenant Settings toggle.
 *
 * Read path (catalog sync, search_products) only needs an API key.
 * Write path (mirror client/order/brief) additionally requires an
 * explicit enable flag so new tenants stay local-DB-only by default.
 */

import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from './integration-config.js';

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
}

/** True when writes are enabled AND a CRM API key is configured. */
export async function isCrmWriteReady(): Promise<CrmWriteReadyResult> {
  const envEnabled = config.CRM_WRITE_ENABLED;
  const settingsEnabled = envEnabled ? false : await isCrmWriteEnabledInSettings();
  const enabled = envEnabled || settingsEnabled;

  if (!enabled) {
    return {
      ready: false,
      enabled: false,
      source: 'none',
      reason: 'Запис замовлень у CRM вимкнено (.env або Налаштування)',
    };
  }

  const { keycrm } = await getIntegrationConfig();
  if (!keycrm.apiKey) {
    return {
      ready: false,
      enabled: true,
      source: envEnabled ? 'env' : 'settings',
      reason: 'API ключ KeyCRM не налаштовано',
    };
  }

  return {
    ready: true,
    enabled: true,
    source: envEnabled ? 'env' : 'settings',
  };
}
