/**
 * runtime-config.ts
 *
 * Runtime gating for the Instagram bot. Controls whether the bot talks to
 * every IG user that writes us (`public`) or only to a small whitelist of
 * usernames used for production-testing (`debug`).
 *
 * Stored under Setting key `runtime_mode`. Cached for 30s — cache is
 * invalidated on PUT /settings so toggling Public⇄Debug takes effect
 * immediately from the admin UI.
 *
 *   {
 *     mode: 'public' | 'debug',
 *     debugWhitelist: string[],   // @handles, lowercased, no '@'
 *     backfillLimit: number,      // default 200 (last-N import)
 *   }
 *
 * Default is `public` so existing tenants keep working when this feature
 * ships without explicit configuration.
 */
import { prisma } from './prisma.js';

export type RuntimeMode = 'public' | 'debug';

export interface RuntimeConfig {
  mode: RuntimeMode;
  debugWhitelist: string[];
  backfillLimit: number;
}

const DEFAULTS: RuntimeConfig = {
  mode: 'public',
  debugWhitelist: [],
  backfillLimit: 200,
};

let _cache: RuntimeConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30_000;

export function normalizeIgHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const row = await prisma.setting.findUnique({
    where: { key: 'runtime_mode' },
  });

  const raw = (row?.value ?? {}) as Partial<RuntimeConfig>;

  const rawList = Array.isArray(raw.debugWhitelist) ? raw.debugWhitelist : [];
  const debugWhitelist = Array.from(
    new Set(
      rawList
        .filter((v): v is string => typeof v === 'string')
        .map((v) => normalizeIgHandle(v))
        .filter((v) => v.length > 0),
    ),
  );

  _cache = {
    mode: raw.mode === 'debug' ? 'debug' : 'public',
    debugWhitelist,
    backfillLimit:
      typeof raw.backfillLimit === 'number' && raw.backfillLimit > 0
        ? Math.min(500, Math.floor(raw.backfillLimit))
        : DEFAULTS.backfillLimit,
  };
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateRuntimeConfigCache(): void {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Decides whether an incoming IG message should be processed given the
 * current runtime config. In `public` mode everything passes. In `debug`
 * mode we accept only messages whose sender @handle matches the
 * configured whitelist.
 *
 * `igUsername` may be null when we haven't yet resolved the profile for
 * this sender — callers should resolve it (DB then Graph API) before
 * consulting this helper, otherwise debug mode falls through as "deny".
 */
export function shouldProcessIncoming(
  config: RuntimeConfig,
  igUsername: string | null | undefined,
): boolean {
  if (config.mode === 'public') return true;
  if (!igUsername) return false;
  return config.debugWhitelist.includes(normalizeIgHandle(igUsername));
}
