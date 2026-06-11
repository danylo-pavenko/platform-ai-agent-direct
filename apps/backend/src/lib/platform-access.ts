import { config } from '../config.js';

/**
 * Platform-level admin-panel access control.
 *
 * Source of truth is the super-admin hub (Tenant.accessExpiresAt + status).
 * The tenant backend asks the hub whether its admin panel is still allowed
 * to operate — on login and on every authenticated admin request (cached).
 *
 * Fail-open by design: if the hub is unreachable or not configured we never
 * lock the tenant out of their own panel; we keep the last known answer or
 * default to "allowed". Blocking only happens on an explicit hub response.
 */

export type PlatformAccess = {
  allowed: boolean;
  /** 'suspended' = manual block by super-admin, 'expired' = subscription date passed */
  reason: 'suspended' | 'expired' | null;
  accessExpiresAt: string | null;
};

const ALLOWED: PlatformAccess = { allowed: true, reason: null, accessExpiresAt: null };

const CACHE_TTL_MS = 60_000;

let cached: PlatformAccess | null = null;
let cachedAt = 0;
let inflight: Promise<PlatformAccess> | null = null;

export async function checkPlatformAccess(): Promise<PlatformAccess> {
  // Access control disabled when the hub link is not configured.
  if (!config.SA_INTERNAL_URL || !config.SUPERVISOR_SHARED_SECRET) {
    return ALLOWED;
  }

  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Coalesce concurrent requests into one hub call.
  if (!inflight) {
    inflight = fetchAccess().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function fetchAccess(): Promise<PlatformAccess> {
  const url = `${config.SA_INTERNAL_URL}/api/tenants/by-instance/${config.INSTANCE_ID}/access`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET },
      signal: AbortSignal.timeout(5_000),
    });

    // 404 = tenant not registered in the hub; any other non-OK = hub problem.
    // Both fail open — only an explicit { allowed: false } blocks access.
    if (!res.ok) {
      return cached ?? ALLOWED;
    }

    const data = (await res.json()) as Partial<PlatformAccess>;
    const result: PlatformAccess = {
      allowed: data.allowed !== false,
      reason: data.reason === 'suspended' || data.reason === 'expired' ? data.reason : null,
      accessExpiresAt: typeof data.accessExpiresAt === 'string' ? data.accessExpiresAt : null,
    };
    cached = result;
    cachedAt = Date.now();
    return result;
  } catch {
    // Hub unreachable — keep last known answer (even stale) or allow.
    return cached ?? ALLOWED;
  }
}

/** Test helper / manual cache reset (e.g. after hub-side changes). */
export function resetPlatformAccessCache(): void {
  cached = null;
  cachedAt = 0;
}
