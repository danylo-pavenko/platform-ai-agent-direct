/**
 * webhooks.ts — Platform-level Instagram webhook dispatcher.
 *
 * Architecture: ONE Meta App → ONE Callback URL (this endpoint) → routes
 * each event to the correct tenant's backend by matching entry[].id (PAGE_ID)
 * against instagramUserId + instagramRoutingIds on each Tenant record.
 *
 * Flow:
 *   GET  /webhooks/instagram  → Meta challenge verification
 *   POST /webhooks/instagram  → verify HMAC per tenant → forward to localhost:apiPort
 *
 * Forwarding uses internal localhost routing (no external DNS / TLS needed).
 * The raw body + X-Hub-Signature-256 are forwarded unchanged so each tenant
 * backend can re-verify the signature with its own FACEBOOK_APP_SECRET.
 *
 * Every inbound call is also recorded in WebhookInboxEvent for Super Admin ops UI.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  collectTenantInstagramRoutingIds,
  collectWebhookDebugCandidateIds,
  collectWebhookRoutingCandidateIds,
  tenantMatchesWebhookCandidates,
} from '../lib/tenant-webhook-routing.js';
import {
  buildMessagingPreviews,
  derivePostStatus,
  recordWebhookInboxEvent,
  type ForwardResultRow,
} from '../lib/webhook-inbox.js';

interface RawRequest extends FastifyRequest {
  rawBodyBuf?: Buffer;
}

interface MetaWebhookBody {
  object: string;
  entry?: Array<{ id: string; [key: string]: unknown }>;
}

function verifyHmac(payload: Buffer, signature: string, secret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
}

function summarizeHubIgWebhook(body: MetaWebhookBody): Record<string, unknown> {
  const entries = body.entry ?? [];
  let messaging = 0;
  let standby = 0;
  let changes = 0;
  for (const e of entries) {
    messaging += ((e as { messaging?: unknown[] }).messaging ?? []).length;
    standby += ((e as { standby?: unknown[] }).standby ?? []).length;
    changes += ((e as { changes?: unknown[] }).changes ?? []).length;
  }
  return {
    object: body.object,
    entryCount: entries.length,
    messagingEvents: messaging,
    standbyEvents: standby,
    changesFields: changes,
    entryIds: entries.map((x) => x.id).slice(0, 4),
    previews: buildMessagingPreviews(body as { entry?: Array<Record<string, unknown>> }),
  };
}

export async function webhookRoutes(app: FastifyInstance) {
  // Capture raw body for HMAC verification before JSON parsing.
  // Scoped to this plugin — does not affect other routes.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as RawRequest).rawBodyBuf = body;
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // ── GET: Meta challenge verification ────────────────────────────────────────
  app.get<{
    Querystring: {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };
  }>('/webhooks/instagram', async (request, reply) => {
    const mode      = request.query['hub.mode'];
    const token     = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.PLATFORM_WEBHOOK_VERIFY_TOKEN) {
      app.log.info('Platform webhook hub: Meta challenge verification succeeded');
      void recordWebhookInboxEvent({
        kind: 'verify_ok',
        status: 'verify_ok',
        entrySummary: { mode, tokenPresent: true },
      });
      return reply.code(200).type('text/plain').send(challenge);
    }

    app.log.warn(
      { mode, tokenPresent: !!token },
      'Platform webhook hub: challenge verification failed',
    );
    void recordWebhookInboxEvent({
      kind: 'verify_fail',
      status: 'verify_fail',
      entrySummary: { mode, tokenPresent: !!token },
    });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  // ── POST: Receive event → route to tenant ────────────────────────────────────
  app.post<{ Body: MetaWebhookBody }>('/webhooks/instagram', async (request, reply) => {
    app.log.debug(
      { summary: summarizeHubIgWebhook(request.body as MetaWebhookBody) },
      'Instagram webhook received (hub)',
    );
    // Respond 200 immediately — Meta requires a reply within 5 seconds.
    reply.code(200).send('EVENT_RECEIVED');

    const req = request as RawRequest;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = req.rawBodyBuf;
    const signaturePresent = Boolean(signature);

    if (!rawBody) {
      app.log.warn('Webhook hub: no raw body captured');
      void recordWebhookInboxEvent({
        kind: 'post',
        status: 'no_body',
        signaturePresent,
        objectType: (req.body as MetaWebhookBody | undefined)?.object,
      });
      return;
    }

    const body = req.body as MetaWebhookBody;
    const summary = summarizeHubIgWebhook(body);

    if (body?.object !== 'instagram') {
      app.log.debug({ object: body?.object }, 'Webhook hub: ignoring non-instagram event');
      void recordWebhookInboxEvent({
        kind: 'post',
        status: 'ignored',
        objectType: body?.object ?? null,
        entrySummary: summary,
        signaturePresent,
        rawBody,
      });
      return;
    }

    const entries = body.entry ?? [];

    const routingCandidateIds = collectWebhookRoutingCandidateIds(entries);
    const debugCandidateIds = collectWebhookDebugCandidateIds(entries);
    const routingIdsArr = [...routingCandidateIds];
    const debugIdsArr = [...debugCandidateIds];

    if (routingCandidateIds.size === 0) {
      app.log.warn(
        {
          summary,
          debugCandidateIds: debugIdsArr.slice(0, 8),
        },
        'Webhook hub: no routing candidate ids in payload',
      );
      void recordWebhookInboxEvent({
        kind: 'post',
        status: 'unmatched',
        objectType: 'instagram',
        routingCandidateIds: [],
        debugCandidateIds: debugIdsArr,
        entrySummary: summary,
        signaturePresent,
        rawBody,
      });
      return;
    }

    // Find all active tenants matching any candidate ID. Deduplicate by tenant
    // so we forward the payload exactly once per tenant even if multiple IDs match.
    const seenTenants = new Set<string>();
    const matchedTenantIds: string[] = [];
    const forwardResults: ForwardResultRow[] = [];
    let forwardedCount = 0;

    const activeTenants = await prisma.tenant.findMany({
      where: { status: { not: 'suspended' }, instagramUserId: { not: null } },
    });

    const { getServerForTenant } = await import('../lib/servers.js');
    const { resolveTenantWebhookUrl } = await import('../lib/worker/tenant-url.js');

    for (const tenant of activeTenants) {
      if (!tenantMatchesWebhookCandidates(tenant, routingCandidateIds)) continue;
      if (seenTenants.has(tenant.id)) continue;
      seenTenants.add(tenant.id);
      matchedTenantIds.push(tenant.id);

      const routingIds = collectTenantInstagramRoutingIds(tenant);
      const matchedId =
        [...routingCandidateIds].find((id) => routingIds.has(id)) ?? tenant.instagramUserId;

      // Verify HMAC with the platform-level App Secret (one shared Meta App for all tenants).
      // If PLATFORM_FACEBOOK_APP_SECRET is not set, skip verification and let the tenant
      // backend verify independently with its own FACEBOOK_APP_SECRET.
      if (config.PLATFORM_FACEBOOK_APP_SECRET) {
        if (!signature) {
          app.log.warn({ matchedId, tenantId: tenant.id }, 'Webhook hub: missing X-Hub-Signature-256, skipping');
          forwardResults.push({
            tenantId: tenant.id,
            instanceId: tenant.instanceId,
            url: '',
            ok: false,
            matchedId,
            skippedReason: 'hmac_missing',
            error: 'missing X-Hub-Signature-256',
          });
          continue;
        }
        if (!verifyHmac(rawBody, signature, config.PLATFORM_FACEBOOK_APP_SECRET)) {
          app.log.warn({ matchedId, tenantId: tenant.id }, 'Webhook hub: HMAC verification failed');
          forwardResults.push({
            tenantId: tenant.id,
            instanceId: tenant.instanceId,
            url: '',
            ok: false,
            matchedId,
            skippedReason: 'hmac_failed',
            error: 'HMAC verification failed',
          });
          continue;
        }
      } else {
        app.log.debug({ matchedId }, 'Webhook hub: PLATFORM_FACEBOOK_APP_SECRET not set, skipping HMAC check');
      }

      // Local workers: loopback. Remote workers: https://{apiDomain}.
      const server = await getServerForTenant(tenant.serverId);
      const targetUrl = resolveTenantWebhookUrl(tenant, server);

      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
            'X-Forwarded-By': 'platform-hub',
          },
          body: rawBody,
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          forwardedCount++;
          forwardResults.push({
            tenantId: tenant.id,
            instanceId: tenant.instanceId,
            url: targetUrl,
            ok: true,
            statusCode: res.status,
            matchedId,
          });
          app.log.info(
            {
              matchedId,
              tenantRoutingIds: [...routingIds].slice(0, 6),
              tenantId: tenant.id,
              instanceId: tenant.instanceId,
              port: tenant.apiPort,
              status: res.status,
            },
            'Webhook hub: event forwarded to tenant',
          );
        } else {
          const bodyText = await res.text().catch(() => '');
          forwardResults.push({
            tenantId: tenant.id,
            instanceId: tenant.instanceId,
            url: targetUrl,
            ok: false,
            statusCode: res.status,
            matchedId,
            error: bodyText.slice(0, 200) || `HTTP ${res.status}`,
          });
          app.log.warn(
            {
              matchedId,
              tenantId: tenant.id,
              instanceId: tenant.instanceId,
              port: tenant.apiPort,
              status: res.status,
              body: bodyText.slice(0, 200),
            },
            'Webhook hub: tenant returned non-OK status',
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        forwardResults.push({
          tenantId: tenant.id,
          instanceId: tenant.instanceId,
          url: targetUrl,
          ok: false,
          matchedId,
          error: message,
        });
        app.log.error(
          { err, matchedId, tenantId: tenant.id, port: tenant.apiPort },
          'Webhook hub: failed to forward event to tenant',
        );
      }
    }

    if (forwardedCount === 0) {
      const tenantRoutingSnapshot = activeTenants
        .filter((t) => t.instagramUserId)
        .map((t) => ({
          instanceId: t.instanceId,
          routingIds: [...collectTenantInstagramRoutingIds(t)].slice(0, 6),
        }));
      app.log.warn(
        {
          routingCandidateIds: routingIdsArr.slice(0, 12),
          debugCandidateIds: debugIdsArr.slice(0, 12),
          matchedTenantCount: seenTenants.size,
          tenantRoutingSnapshot,
          summary,
        },
        'Webhook hub: event not delivered to any tenant',
      );
    }

    const status = derivePostStatus({
      objectType: body.object,
      routingCandidateCount: routingCandidateIds.size,
      matchedCount: seenTenants.size,
      forwardResults,
    });

    void recordWebhookInboxEvent({
      kind: 'post',
      status,
      objectType: 'instagram',
      routingCandidateIds: routingIdsArr,
      debugCandidateIds: debugIdsArr,
      entrySummary: summary,
      matchedTenantIds,
      forwardResults,
      signaturePresent,
      rawBody,
    });
  });
}
