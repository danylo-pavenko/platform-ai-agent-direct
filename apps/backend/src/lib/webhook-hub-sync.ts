import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { resolveInstagramWebhookRoutingIds } from './meta-ig-routing-ids.js';

const defaultLog = pino({ name: 'webhook-hub-sync' });

function missingHubSyncEnv(): string[] {
  const missing: string[] = [];
  if (!config.SA_INTERNAL_URL) missing.push('SA_INTERNAL_URL');
  if (!config.INSTANCE_ID) missing.push('INSTANCE_ID');
  if (!config.SUPERVISOR_SHARED_SECRET) missing.push('SUPERVISOR_SHARED_SECRET');
  return missing;
}

/**
 * Register instagramUserId (+ extra webhook routing ids) on the platform hub so
 * POST /webhooks/instagram routes events to this tenant's localhost:apiPort.
 */
export function syncWebhookRoutingToHub(
  igUserId: string,
  facebookAppSecret: string,
  log: FastifyBaseLogger | pino.Logger = defaultLog,
  pageAccessToken?: string,
  pageId?: string,
): void {
  if (!igUserId || !facebookAppSecret) {
    log.warn('Webhook hub sync skipped — missing igUserId or facebookAppSecret');
    return;
  }

  const missing = missingHubSyncEnv();
  if (missing.length > 0) {
    log.warn(
      { missing, instanceId: config.INSTANCE_ID || null },
      'Webhook hub sync skipped — set missing env vars (SA merges SA_INTERNAL_URL on provision)',
    );
    return;
  }

  void (async () => {
    let instagramRoutingIds: string[] | undefined;
    if (pageAccessToken) {
      instagramRoutingIds = await resolveInstagramWebhookRoutingIds(
        igUserId,
        pageAccessToken,
        pageId,
      );
    } else if (pageId) {
      instagramRoutingIds = [pageId];
    }

    const syncUrl = `${config.SA_INTERNAL_URL}/api/tenants/by-instance/${config.INSTANCE_ID}/webhook-config`;
    try {
      const res = await fetch(syncUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET,
        },
        body: JSON.stringify({
          instagramUserId: igUserId,
          instagramRoutingIds,
          facebookAppSecret,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { instagramRoutingIds?: string[] };
        log.info(
          { igUserId, instagramRoutingIds: body.instagramRoutingIds ?? instagramRoutingIds },
          'Webhook hub routing synced',
        );
      } else {
        const txt = await res.text().catch(() => '');
        log.warn(
          {
            status: res.status,
            body: txt.slice(0, 300),
            igUserId,
            instanceId: config.INSTANCE_ID,
            syncUrl,
          },
          'Webhook hub sync failed',
        );
      }
    } catch (err) {
      log.warn({ err, igUserId, syncUrl }, 'Webhook hub sync error (non-fatal)');
    }
  })();
}

export async function clearWebhookRoutingOnHub(
  log: FastifyBaseLogger | pino.Logger = defaultLog,
): Promise<boolean> {
  const missing = missingHubSyncEnv();
  if (missing.length > 0) {
    log.warn({ missing }, 'Webhook hub clear skipped — missing env vars');
    return false;
  }

  const syncUrl = `${config.SA_INTERNAL_URL}/api/tenants/by-instance/${config.INSTANCE_ID}/webhook-config`;
  try {
    const res = await fetch(syncUrl, {
      method: 'DELETE',
      headers: { 'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      log.info('Webhook hub routing cleared');
      return true;
    }
    const txt = await res.text().catch(() => '');
    log.warn({ status: res.status, body: txt.slice(0, 200) }, 'Webhook hub clear failed');
    return false;
  } catch (err) {
    log.warn({ err }, 'Webhook hub clear error (non-fatal)');
    return false;
  }
}
