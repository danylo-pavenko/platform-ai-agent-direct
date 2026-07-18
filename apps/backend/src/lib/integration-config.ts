/**
 * Integration config - reads from DB settings with .env fallback.
 *
 * Stored in the `settings` table:
 *   integration_meta      → { facebookAppId, facebookAppSecret, pageId,
 *                             pageAccessToken, igUserId, igUsername, verifyToken }
 *   integration_telegram  → { botToken, managerGroupId, adminPassword, bots[] }
 *   integration_keycrm    → { apiKey, syncIntervalMin, defaultSourceId }
 *   integration_novaposhta→ { apiKey, senderCity, senderCityRef }
 *
 * The Meta shape uses Facebook Login for Business:
 * OAuth flow → User Access Token → Page Access Token stored as pageAccessToken.
 * facebookAppSecret is used for webhook HMAC signature verification.
 *
 * The result is cached for 60 seconds to avoid DB hits on every request.
 * Call invalidateIntegrationConfigCache() after a PUT /settings/integrations.
 */

import { prisma } from './prisma.js';
import { config } from '../config.js';
import { sanitizeIntegrationSecret } from './integration-secrets.js';
import { normalizeKeycrmAppUrl } from './keycrm-urls.js';
import {
  normalizeTelegramConfig,
  type TelegramBotConfig,
} from './telegram-bots.js';

export type { TelegramBotConfig, TelegramNotifyChannel } from './telegram-bots.js';

export interface IntegrationMeta {
  facebookAppId: string;
  facebookAppSecret: string;
  pageId: string;
  pageAccessToken: string;
  userAccessToken: string;
  igUserId: string;
  igUsername: string;
  verifyToken: string;
}

export interface IntegrationTelegram {
  botToken: string;
  managerGroupId: string;
  adminPassword: string;
  /** Multi-bot list; normalized on read (legacy flat fields → one primary bot). */
  bots: TelegramBotConfig[];
}

export interface IntegrationKeycrm {
  apiKey: string;
  syncIntervalMin: number;
  /** KeyCRM source_id for API order/lead creation (DB → .env fallback). */
  defaultSourceId: number;
  /** Tenant web UI base, e.g. https://blessed.keycrm.app — required for order deep links. */
  appUrl: string;
}

export interface IntegrationNovaPoshta {
  apiKey: string;
  senderCity: string;
  senderCityRef: string;
}

export interface IntegrationCleverbox {
  apiToken: string;
  defaultBranchId: string;
  syncIntervalMin: number;
}

export interface IntegrationBeautypro {
  applicationId: string;
  applicationSecret: string;
  databaseCode: string;
  defaultLocationId: string;
  syncIntervalMin: number;
  /** Persisted after Marketplace grant / refresh — masked in GET. */
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  apiServer: number;
  authStatus: 'pending' | 'granted' | 'refused' | '';
}

export interface IntegrationConfig {
  meta: IntegrationMeta;
  telegram: IntegrationTelegram;
  keycrm: IntegrationKeycrm;
  cleverbox: IntegrationCleverbox;
  beautypro: IntegrationBeautypro;
  novaposhta: IntegrationNovaPoshta;
}

let _cache: IntegrationConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getIntegrationConfig(opts?: { fresh?: boolean }): Promise<IntegrationConfig> {
  if (!opts?.fresh && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          'integration_meta',
          'integration_telegram',
          'integration_keycrm',
          'integration_cleverbox',
          'integration_beautypro',
          'integration_novaposhta',
        ],
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
  const cb = (db['integration_cleverbox'] ?? {}) as Partial<IntegrationCleverbox>;
  const bp = (db['integration_beautypro'] ?? {}) as Partial<IntegrationBeautypro>;
  const np = (db['integration_novaposhta'] ?? {}) as Partial<IntegrationNovaPoshta>;

  const bpAuthStatus =
    bp.authStatus === 'pending' ||
    bp.authStatus === 'granted' ||
    bp.authStatus === 'refused'
      ? bp.authStatus
      : '';

  _cache = {
    meta: {
      facebookAppId:     config.FACEBOOK_APP_ID,      // env-only, never from DB
      facebookAppSecret: config.FACEBOOK_APP_SECRET,   // env-only, never from DB
      pageId:            m.pageId            || '',
      pageAccessToken:   sanitizeIntegrationSecret(m.pageAccessToken),
      userAccessToken:   sanitizeIntegrationSecret(m.userAccessToken),
      igUserId:          m.igUserId          || '',
      igUsername:        m.igUsername        || '',
      verifyToken:       config.IG_WEBHOOK_VERIFY_TOKEN, // env-only
    },
    telegram: normalizeTelegramConfig({
      botToken: sanitizeIntegrationSecret(t.botToken) || config.TELEGRAM_BOT_TOKEN,
      managerGroupId: t.managerGroupId || config.TELEGRAM_MANAGER_GROUP_ID,
      adminPassword: t.adminPassword || config.TELEGRAM_ADMIN_PASSWORD,
      bots: Array.isArray((t as { bots?: unknown }).bots)
        ? (t as { bots: unknown[] }).bots
        : undefined,
    }),
    keycrm: {
      apiKey:          sanitizeIntegrationSecret(k.apiKey) || config.KEYCRM_API_KEY,
      syncIntervalMin: k.syncIntervalMin  ?? config.KEYCRM_SYNC_INTERVAL_MIN,
      defaultSourceId:
        typeof k.defaultSourceId === 'number' && k.defaultSourceId > 0
          ? k.defaultSourceId
          : config.KEYCRM_DEFAULT_SOURCE_ID,
      appUrl:
        normalizeKeycrmAppUrl(k.appUrl) ??
        normalizeKeycrmAppUrl(config.KEYCRM_APP_URL) ??
        '',
    },
    cleverbox: {
      apiToken: sanitizeIntegrationSecret(cb.apiToken) || config.CLEVERBOX_API_TOKEN,
      defaultBranchId: cb.defaultBranchId || config.CLEVERBOX_DEFAULT_BRANCH_ID,
      syncIntervalMin: cb.syncIntervalMin ?? config.CLEVERBOX_SYNC_INTERVAL_MIN,
    },
    beautypro: {
      applicationId:
        (typeof bp.applicationId === 'string' ? bp.applicationId : '') ||
        config.BEAUTYPRO_APPLICATION_ID,
      applicationSecret:
        sanitizeIntegrationSecret(bp.applicationSecret) ||
        config.BEAUTYPRO_APPLICATION_SECRET,
      databaseCode:
        (typeof bp.databaseCode === 'string' ? bp.databaseCode : '') ||
        config.BEAUTYPRO_DATABASE_CODE,
      defaultLocationId:
        (typeof bp.defaultLocationId === 'string' ? bp.defaultLocationId : '') ||
        config.BEAUTYPRO_DEFAULT_LOCATION_ID,
      syncIntervalMin: bp.syncIntervalMin ?? config.BEAUTYPRO_SYNC_INTERVAL_MIN,
      accessToken: sanitizeIntegrationSecret(bp.accessToken),
      refreshToken: sanitizeIntegrationSecret(bp.refreshToken),
      tokenExpiresAt: typeof bp.tokenExpiresAt === 'string' ? bp.tokenExpiresAt : '',
      apiServer:
        typeof bp.apiServer === 'number' && bp.apiServer > 0 ? bp.apiServer : 1,
      authStatus: bpAuthStatus,
    },
    novaposhta: {
      apiKey:          sanitizeIntegrationSecret(np.apiKey) || config.NOVA_POSHTA_API_KEY,
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
  integration_meta:        ['pageAccessToken', 'userAccessToken'],
  integration_telegram:    ['botToken', 'adminPassword'],
  integration_keycrm:      ['apiKey'],
  integration_cleverbox:   ['apiToken'],
  integration_beautypro:   ['applicationSecret', 'accessToken', 'refreshToken'],
  integration_novaposhta:  ['apiKey'],
};

/** Fields that must come from .env only — stripped from PUT /integrations requests */
export const META_ENV_ONLY_FIELDS = ['facebookAppId', 'facebookAppSecret', 'verifyToken'];
