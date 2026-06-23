import crypto from 'node:crypto';

/** Keep in sync with apps/backend/src/lib/meta-oauth-hub.ts */
const HUB_STATE_PREFIX = 'hub.';

export interface HubOAuthStatePayload {
  i: string;
  n: string;
  e: number;
}

export function parseHubOAuthState(
  state: string,
  secret: string,
): HubOAuthStatePayload | null {
  if (!state.startsWith(HUB_STATE_PREFIX) || !secret) return null;
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
