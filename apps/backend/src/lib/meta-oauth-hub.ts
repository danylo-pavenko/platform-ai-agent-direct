import crypto from 'node:crypto';
import { config } from '../config.js';

const HUB_STATE_PREFIX = 'hub.';

export interface HubOAuthStatePayload {
  /** instanceId */
  i: string;
  /** nonce */
  n: string;
  /** expiresAt ms */
  e: number;
}

/** Platform tenant API host: api-{slug}.{base} */
const PLATFORM_API_DOMAIN_RE = /^api-([a-z0-9-]{2,24})\.(.+)$/i;

export function isHubOAuthState(state: string): boolean {
  return state.startsWith(HUB_STATE_PREFIX);
}

export function resolvePlatformOAuthHubUrl(apiDomain: string): string | null {
  const m = apiDomain.match(PLATFORM_API_DOMAIN_RE);
  if (!m) return null;
  return `https://admin.${m[2]}/settings/meta/oauth-callback`;
}

/**
 * OAuth redirect_uri for this deployment.
 * Platform tenants (api-{slug}.*) use the super-admin hub when SUPERVISOR_SHARED_SECRET is set.
 */
export function resolveOAuthRedirectUri(): string {
  const override = config.META_OAUTH_REDIRECT_URL.trim();
  if (override) return override;

  const hub = resolvePlatformOAuthHubUrl(config.API_DOMAIN);
  if (hub && config.SUPERVISOR_SHARED_SECRET) return hub;

  if (config.API_DOMAIN === 'localhost') {
    return `http://localhost:${config.API_PORT}/settings/meta/oauth-callback`;
  }
  return `https://${config.API_DOMAIN}/settings/meta/oauth-callback`;
}

export function usesCentralOAuthHub(redirectUri: string): boolean {
  const local =
    config.API_DOMAIN === 'localhost'
      ? `http://localhost:${config.API_PORT}/settings/meta/oauth-callback`
      : `https://${config.API_DOMAIN}/settings/meta/oauth-callback`;
  return redirectUri !== local;
}

export function createHubOAuthState(instanceId: string, secret: string): string {
  const payload: HubOAuthStatePayload = {
    i: instanceId,
    n: crypto.randomBytes(8).toString('hex'),
    e: Date.now() + 10 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${HUB_STATE_PREFIX}${body}.${sig}`;
}

export function verifyHubOAuthState(
  state: string,
  instanceId: string,
  secret: string,
): boolean {
  const parsed = parseHubOAuthState(state, secret);
  return parsed?.i === instanceId && Date.now() <= parsed.e;
}

/** Verify signature and return payload (for super-admin proxy). */
export function parseHubOAuthState(
  state: string,
  secret: string,
): HubOAuthStatePayload | null {
  if (!isHubOAuthState(state) || !secret) return null;
  const rest = state.slice(HUB_STATE_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as HubOAuthStatePayload;
    if (!payload?.i || typeof payload.e !== 'number') return null;
    if (Date.now() > payload.e) return null;
    return payload;
  } catch {
    return null;
  }
}
