/**
 * ig-profile.ts
 *
 * Fetches Instagram user profile information via the Facebook Graph API.
 * Called once when a new client first contacts us - gives us their
 * real name and @handle so Claude can address them properly.
 *
 * Endpoint: GET /{igsid}?fields=name,username
 * Auth: Page Access Token via Bearer header
 */

import pino from 'pino';
import { getIntegrationConfig } from '../lib/integration-config.js';

const log = pino({ name: 'ig-profile' });

const FB_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

const PROFILE_FIELDS = 'name,username';

export interface IgUserProfile {
  name?: string;
  username?: string;
}

/**
 * Fetches the Instagram profile for a given IGSID (Instagram-Scoped User ID).
 *
 * Returns null on any error - callers should treat a missing profile
 * as non-critical and continue with igUserId as the identifier.
 */
export async function fetchIgUserProfile(
  igScopedUserId: string,
): Promise<IgUserProfile | null> {
  try {
    const { meta } = await getIntegrationConfig();
    if (!meta.pageAccessToken) return null;

    const url = new URL(`${FB_GRAPH_BASE}/${igScopedUserId}`);
    url.searchParams.set('fields', PROFILE_FIELDS);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${meta.pageAccessToken}`,
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.warn(
        { igScopedUserId, status: response.status, body: body.slice(0, 200) },
        'IG profile fetch returned non-OK status',
      );
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;

    const profile: IgUserProfile = {};
    if (typeof data.name === 'string' && data.name.trim()) {
      profile.name = data.name.trim();
    }
    if (typeof data.username === 'string' && data.username.trim()) {
      profile.username = data.username.trim();
    }

    log.info(
      { igScopedUserId, name: profile.name, username: profile.username },
      'Fetched IG user profile',
    );

    return profile;
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    (isTimeout ? log.warn : log.error)(
      { err, igScopedUserId },
      'Failed to fetch IG user profile',
    );
    return null;
  }
}
