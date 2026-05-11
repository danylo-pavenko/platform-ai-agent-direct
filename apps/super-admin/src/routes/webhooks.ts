/**
 * webhooks.ts — Platform-level Instagram webhook dispatcher.
 *
 * Architecture: ONE Meta App → ONE Callback URL (this endpoint) → routes
 * each event to the correct tenant's backend by matching entry[].id (PAGE_ID)
 * against the facebookPageId stored on each Tenant record.
 *
 * Flow:
 *   GET  /webhooks/instagram  → Meta challenge verification
 *   POST /webhooks/instagram  → verify HMAC per tenant → forward to localhost:apiPort
 *
 * Forwarding uses internal localhost routing (no external DNS / TLS needed).
 * The raw body + X-Hub-Signature-256 are forwarded unchanged so each tenant
 * backend can re-verify the signature with its own FACEBOOK_APP_SECRET.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';

const prisma = new PrismaClient();

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
      return reply.code(200).type('text/plain').send(challenge);
    }

    app.log.warn(
      { mode, tokenPresent: !!token },
      'Platform webhook hub: challenge verification failed',
    );
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

    if (!rawBody) {
      app.log.warn('Webhook hub: no raw body captured');
      return;
    }

    const body = req.body as MetaWebhookBody;

    if (body?.object !== 'instagram') {
      app.log.debug({ object: body?.object }, 'Webhook hub: ignoring non-instagram event');
      return;
    }

    const entries = body.entry ?? [];

    // Collect all candidate routing IDs from this payload.
    // Meta uses different values in entry[].id depending on event type:
    //   message_edit  → entry.id = business IG account ID (reliable)
    //   messages      → entry.id = SENDER's IG ID (useless for routing)
    // So we also extract recipient.id from inside messaging[] and changes[]
    // events, where it's always the business IG account ID.
    const candidateIds = new Set<string>();
    for (const entry of entries) {
      if (entry.id && entry.id !== '0') candidateIds.add(entry.id);
      for (const m of (entry as any).messaging ?? []) {
        if (m.recipient?.id) candidateIds.add(m.recipient.id);
        if (m.sender?.id)    candidateIds.add(m.sender.id);
      }
      // DM payloads when this app is not the active owner (see `standby` subscription).
      for (const s of (entry as any).standby ?? []) {
        if (s.recipient?.id) candidateIds.add(s.recipient.id);
        if (s.sender?.id)    candidateIds.add(s.sender.id);
      }
      for (const c of (entry as any).changes ?? []) {
        if (c.value?.recipient?.id) candidateIds.add(c.value.recipient.id);
        if (c.value?.sender?.id) candidateIds.add(c.value.sender.id);
      }
    }

    if (candidateIds.size === 0) return;

    // Find all active tenants matching any candidate ID. Deduplicate by tenant
    // so we forward the payload exactly once per tenant even if multiple IDs match.
    const seenTenants = new Set<string>();

    for (const pageId of candidateIds) {
      const tenant = await prisma.tenant.findFirst({
        where: { instagramUserId: pageId, status: { not: 'suspended' } },
      });

      if (!tenant) {
        app.log.debug({ pageId }, 'Webhook hub: no tenant for candidate id');
        continue;
      }

      if (seenTenants.has(tenant.id)) continue;
      seenTenants.add(tenant.id);

      // Verify HMAC with the platform-level App Secret (one shared Meta App for all tenants).
      // If PLATFORM_FACEBOOK_APP_SECRET is not set, skip verification and let the tenant
      // backend verify independently with its own FACEBOOK_APP_SECRET.
      if (config.PLATFORM_FACEBOOK_APP_SECRET) {
        if (!signature) {
          app.log.warn({ pageId, tenantId: tenant.id }, 'Webhook hub: missing X-Hub-Signature-256, skipping');
          continue;
        }
        if (!verifyHmac(rawBody, signature, config.PLATFORM_FACEBOOK_APP_SECRET)) {
          app.log.warn({ pageId, tenantId: tenant.id }, 'Webhook hub: HMAC verification failed');
          continue;
        }
      } else {
        app.log.debug({ pageId }, 'Webhook hub: PLATFORM_FACEBOOK_APP_SECRET not set, skipping HMAC check');
      }

      // Forward raw payload to tenant backend via internal localhost routing.
      const targetUrl = `http://localhost:${tenant.apiPort}/webhooks/instagram`;

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

        app.log.debug(
          {
            pageId,
            tenantId: tenant.id,
            instanceId: tenant.instanceId,
            port: tenant.apiPort,
            status: res.status,
          },
          'Webhook hub: event forwarded to tenant',
        );
      } catch (err) {
        app.log.error(
          { err, pageId, tenantId: tenant.id, port: tenant.apiPort },
          'Webhook hub: failed to forward event to tenant',
        );
      }
    }
  });
}
