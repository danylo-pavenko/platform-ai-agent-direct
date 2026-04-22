/**
 * Integration config - reads from DB settings with .env fallback.
 *
 * Stored in the `settings` table:
 *   integration_meta      → { instagramAppId, instagramAppSecret, igUserId,
 *                             igUsername, igAccessToken, igTokenExpiresAt,
 *                             verifyToken }
 *   integration_telegram  → { botToken, managerGroupId, adminPassword }
 *   integration_keycrm    → { apiKey, syncIntervalMin }
 *   integration_novaposhta→ { apiKey, senderCity, senderCityRef }
 *
 * The Meta shape matches the "Instagram API with Instagram Login" flow:
 * tokens come directly from the IG Business/Creator account, not via a
 * Facebook Page. instagramAppSecret is used both for token exchange and
 * for webhook HMAC signature verification.
 *
 * The result is cached for 60 seconds to avoid DB hits on every request.
 * Call invalidateIntegrationConfigCache() after a PUT /settings/integrations.
 */

import { prisma } from './prisma.js';
import { config } from '../config.js';

export interface IntegrationMeta {
  instagramAppId: string;
  instagramAppSecret: string;
  igUserId: string;
  igUsername: string;
  igAccessToken: string;
  igTokenExpiresAt: string;
  verifyToken: string;
}

export interface IntegrationTelegram {
  botToken: string;
  managerGroupId: string;
  adminPassword: string;
}

export interface IntegrationKeycrm {
  apiKey: string;
  syncIntervalMin: number;
}

export interface IntegrationNovaPoshta {
  apiKey: string;
  senderCity: string;
  senderCityRef: string;
}

export interface IntegrationConfig {
  meta: IntegrationMeta;
  telegram: IntegrationTelegram;
  keycrm: IntegrationKeycrm;
  novaposhta: IntegrationNovaPoshta;
}

let _cache: IntegrationConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getIntegrationConfig(): Promise<IntegrationConfig> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: ['integration_meta', 'integration_telegram', 'integration_keycrm', 'integration_novaposhta'],
      },
    },
  });

  const db: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    db[row.key] = row.value as Record<string, unknown>;
  }

  const m = (db['integration_meta'] ?? {}) as Partial<IntegrationMeta>;
  const t = (db['integration_telegram'] ?? {}) as Partial<IntegrationTelegram>;
  const k = (db['integration_keycrm'] ?? {}) as Partial<IntegrationKeycrm>;
  const np = (db['integration_novaposhta'] ?? {}) as Partial<IntegrationNovaPoshta>;

  _cache = {
    meta: {
      instagramAppId:     m.instagramAppId     || config.INSTAGRAM_APP_ID,
      instagramAppSecret: m.instagramAppSecret || config.INSTAGRAM_APP_SECRET,
      igUserId:           m.igUserId           || config.IG_USER_ID,
      igUsername:         m.igUsername         || '',
      igAccessToken:      m.igAccessToken      || config.IG_ACCESS_TOKEN,
      igTokenExpiresAt:   m.igTokenExpiresAt   || '',
      verifyToken:        m.verifyToken        || config.IG_WEBHOOK_VERIFY_TOKEN,
    },
    telegram: {
      botToken:        t.botToken         || config.TELEGRAM_BOT_TOKEN,
      managerGroupId:  t.managerGroupId   || config.TELEGRAM_MANAGER_GROUP_ID,
      adminPassword:   t.adminPassword    || config.TELEGRAM_ADMIN_PASSWORD,
    },
    keycrm: {
      apiKey:          k.apiKey           || config.KEYCRM_API_KEY,
      syncIntervalMin: k.syncIntervalMin  ?? config.KEYCRM_SYNC_INTERVAL_MIN,
    },
    novaposhta: {
      apiKey:          np.apiKey          || config.NOVA_POSHTA_API_KEY,
      senderCity:      np.senderCity      || 'Київ',
      senderCityRef:   np.senderCityRef   || '8d5a980d-391c-11dd-90d9-001a92567626',
    },
  };

  _cacheAt = Date.now();
  return _cache;
}

export function invalidateIntegrationConfigCache(): void {
  _cache = null;
  _cacheAt = 0;
}

/** Sensitive field names - masked as "••••••" in GET responses */
export const SENSITIVE_FIELDS: Record<string, string[]> = {
  integration_meta:        ['instagramAppSecret', 'igAccessToken'],
  integration_telegram:    ['botToken', 'adminPassword'],
  integration_keycrm:      ['apiKey'],
  integration_novaposhta:  ['apiKey'],
};
