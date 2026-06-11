import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { resolveInstagramWebhookRoutingIds } from './meta-ig-routing-ids.js';

const defaultLog = pino({ name: 'webhook-hub-sync' });

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
  if (
    !igUserId ||
    !facebookAppSecret ||
    !config.SA_INTERNAL_URL ||
    !config.INSTANCE_ID ||
    !config.SUPERVISOR_SHARED_SECRET
  ) {
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
        log.info({ igUserId, instagramRoutingIds }, 'Webhook hub routing synced');
      } else {
        const txt = await res.text().catch(() => '');
        log.warn({ status: res.status, body: txt.slice(0, 200), igUserId }, 'Webhook hub sync failed');
      }
    } catch (err) {
      log.warn({ err, igUserId }, 'Webhook hub sync error (non-fatal)');
    }
  })();
}

export function clearWebhookRoutingOnHub(log: FastifyBaseLogger | pino.Logger = defaultLog): void {
  if (!config.SA_INTERNAL_URL || !config.INSTANCE_ID || !config.SUPERVISOR_SHARED_SECRET) {
    return;
  }

  const syncUrl = `${config.SA_INTERNAL_URL}/api/tenants/by-instance/${config.INSTANCE_ID}/webhook-config`;
  fetch(syncUrl, {
    method: 'DELETE',
    headers: { 'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET },
    signal: AbortSignal.timeout(8_000),
  })
    .then(async (res) => {
      if (res.ok) {
        log.info('Webhook hub routing cleared');
      } else {
        const txt = await res.text().catch(() => '');
        log.warn({ status: res.status, body: txt.slice(0, 200) }, 'Webhook hub clear failed');
      }
    })
    .catch((err) => {
      log.warn({ err }, 'Webhook hub clear error (non-fatal)');
    });
}
