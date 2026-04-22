import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { verifyIgSignature } from '../lib/ig-signature.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { sanitizeMessage, detectInjection, redactSensitive } from '../lib/sanitize.js';
import { handleIncomingMessage } from '../services/conversation.js';
import { fetchIgUserProfile } from '../services/ig-profile.js';
import { getAgentConfig } from '../lib/agent-config.js';
import {
  getRuntimeConfig,
  shouldProcessIncoming,
} from '../lib/runtime-config.js';

// ── Meta webhook payload types (subset we care about) ──

/**
 * A "share" attachment - sent when a user forwards an Instagram post into DM.
 * Contains the image, post URL, and caption (title) of the shared content.
 */
interface ShareAttachmentPayload {
  url?: string;         // URL of the shared Instagram post
  title?: string;       // Caption / post description
  image_url?: string;   // Primary image from the shared post (may expire ~1 min)
  link?: string;        // Alternate link (sometimes same as url)
}

/** Generic attachment for images/videos the user sends directly. */
interface MediaAttachmentPayload {
  url?: string;
}

interface MetaAttachment {
  type: 'share' | 'image' | 'video' | 'audio' | 'file' | string;
  payload?: ShareAttachmentPayload | MediaAttachmentPayload;
}

interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: MetaAttachment[];
  };
}

/**
 * Structured representation of a shared Instagram post, stored in
 * Message.sharedPost (JSONB) for reference and future processing.
 *
 * Index signature required for Prisma JSONB compatibility.
 */
export interface SharedPostData {
  postUrl?: string;    // Original IG post link
  imageUrl?: string;   // Image from the shared post
  caption?: string;    // Post caption (raw, unsanitized)
  [key: string]: unknown; // Allows Prisma to accept this as InputJsonValue
}

interface MetaWebhookBody {
  object: string;
  entry?: Array<{
    id: string;
    time: number;
    messaging?: MetaMessagingEvent[];
  }>;
}

/** Augment Fastify request to carry raw body captured by our custom parser */
interface WebhookRequest extends FastifyRequest<{ Body: MetaWebhookBody }> {
  rawBodyBuf?: Buffer;
}

// ── Route plugin ──

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Register a custom content-type parser that captures the raw body
  // while still parsing JSON for the route handler.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body: Buffer, done) => {
      // Attach raw bytes for HMAC verification later
      (_req as WebhookRequest).rawBodyBuf = body;
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // ── GET: Meta verification challenge ──

  app.get<{
    Querystring: {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };
  }>('/webhooks/instagram', async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const { meta: igCfg } = await getIntegrationConfig();
    if (
      mode === 'subscribe' &&
      token === igCfg.verifyToken
    ) {
      app.log.info('Instagram webhook verification succeeded');
      return reply.code(200).type('text/plain').send(challenge);
    }

    app.log.warn({ mode, token: token ? '[present]' : '[missing]' }, 'Instagram webhook verification failed');
    return reply.code(403).send({ error: 'Forbidden' });
  });

  // ── POST: Receive messages ──

  app.post<{ Body: MetaWebhookBody }>('/webhooks/instagram', async (request, reply) => {
    const req = request as WebhookRequest;
    // Verify signature
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = req.rawBodyBuf;

    if (!signature || !rawBody) {
      app.log.warn('Missing signature or raw body on Instagram webhook POST');
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { meta: igMeta } = await getIntegrationConfig();
    if (!verifyIgSignature(rawBody, signature, igMeta.instagramAppSecret)) {
      app.log.warn('Invalid Instagram webhook signature');
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Return 200 immediately - Meta requires response within 5 seconds
    reply.code(200).send('EVENT_RECEIVED');

    // Process asynchronously after response is sent
    const body = req.body as MetaWebhookBody;
    processWebhookEvents(app, body).catch((err) => {
      app.log.error({ err }, 'Failed to process Instagram webhook events');
    });
  });
}

// ── Async event processing ──

async function processWebhookEvents(
  app: FastifyInstance,
  body: MetaWebhookBody,
): Promise<void> {
  if (body.object !== 'instagram') {
    app.log.debug({ object: body.object }, 'Ignoring non-instagram webhook object');
    return;
  }

  const entries = body.entry ?? [];

  for (const entry of entries) {
    const events = entry.messaging ?? [];

    for (const event of events) {
      if (!event.message) {
        // Not a message event (e.g. delivery, read receipt) - skip
        continue;
      }

      try {
        await processMessageEvent(app, event);
      } catch (err) {
        app.log.error(
          { err, senderId: event.sender.id, mid: event.message.mid },
          'Error processing message event',
        );
      }
    }
  }
}

async function processMessageEvent(
  app: FastifyInstance,
  event: MetaMessagingEvent,
): Promise<void> {
  const { sender, message } = event;
  if (!message) return;

  const igUserId = sender.id;
  const igMessageId = message.mid;
  const rawText = message.text ?? '';
  const attachments = message.attachments ?? [];

  // ── Deduplicate by ig_message_id ──
  const existingMessage = await prisma.message.findUnique({
    where: { igMessageId },
  });

  if (existingMessage) {
    app.log.debug({ igMessageId }, 'Duplicate message - skipping');
    return;
  }

  // ── Runtime mode gate (debug whitelist) ──
  // In `debug` mode we intentionally drop messages from anyone who isn't on
  // the production-testing allowlist. The drop happens BEFORE any DB write
  // or Claude call so unwanted senders don't pollute conversations/metrics
  // and aren't billed in tokens. Username is resolved from DB first (cheap);
  // only on cache miss do we hit the Graph API.
  const runtime = await getRuntimeConfig();
  if (runtime.mode === 'debug') {
    const cachedClient = await prisma.client.findUnique({
      where: { igUserId },
      select: { igUsername: true },
    });

    let username = cachedClient?.igUsername ?? null;
    if (!username) {
      const profile = await fetchIgUserProfile(igUserId).catch(() => null);
      username = profile?.username ?? null;
    }

    if (!shouldProcessIncoming(runtime, username)) {
      app.log.info(
        {
          igUserId,
          igUsername: username,
          whitelistSize: runtime.debugWhitelist.length,
        },
        'Debug mode: ignoring message from non-whitelisted IG user',
      );
      return;
    }

    app.log.info(
      { igUserId, igUsername: username },
      'Debug mode: processing message from whitelisted IG user',
    );
  }

  // ── Sanitize & redact ──
  const sanitized = sanitizeMessage(rawText);
  const redacted = redactSensitive(sanitized);

  // ── Detect injection (log only, never block) ──
  if (detectInjection(rawText)) {
    app.log.warn(
      { igUserId, igMessageId },
      'Possible prompt injection detected in incoming message',
    );
  }

  // ── Extract shared post (if user forwarded an IG post into DM) ──
  // The "share" attachment type is sent when a user taps "Send" on a post.
  const shareAttachment = attachments.find((a) => a.type === 'share');
  let sharedPost: SharedPostData | null = null;

  if (shareAttachment) {
    const payload = shareAttachment.payload as ShareAttachmentPayload | undefined;
    sharedPost = {
      postUrl: payload?.url || payload?.link,
      imageUrl: payload?.image_url,
      // Caption comes in as "title" in the share payload
      caption: payload?.title,
    };
    app.log.info(
      { igUserId, igMessageId, postUrl: sharedPost.postUrl },
      'Detected shared Instagram post in message',
    );
  }

  // ── Extract direct media URLs (images/videos the user sends directly) ──
  // Exclude "share" attachments here - shared post image is handled separately
  const mediaUrls = attachments
    .filter((a) => a.type !== 'share')
    .map((a) => (a.payload as MediaAttachmentPayload | undefined)?.url)
    .filter((url): url is string => !!url);

  // If the shared post has an image, include it in mediaUrls so Claude can see it.
  // Image CDN URLs from IG expire quickly - we download them in conversation.ts.
  if (sharedPost?.imageUrl) {
    mediaUrls.unshift(sharedPost.imageUrl);
  }

  // ── Upsert client ──
  // isNew = true means this is the first message from this user ever.
  const existingClient = await prisma.client.findUnique({ where: { igUserId } });
  const isNewClient = !existingClient;

  const client = await prisma.client.upsert({
    where: { igUserId },
    update: { lastActivityAt: new Date() },
    create: {
      igUserId,
      lastActivityAt: new Date(),
    },
  });

  // ── Fetch IG profile for brand-new clients ──
  // This runs asynchronously after upsert - we don't block the message flow.
  // We only fetch on first contact to avoid redundant API calls.
  if (isNewClient) {
    fetchIgUserProfile(igUserId)
      .then(async (profile) => {
        if (!profile || (!profile.name && !profile.username)) return;
        await prisma.client.update({
          where: { id: client.id },
          data: {
            igFullName: profile.name,
            igUsername: profile.username,
            // Pre-populate displayName if not set yet
            displayName: profile.name ?? profile.username,
          },
        });
        app.log.info(
          { clientId: client.id, name: profile.name, username: profile.username },
          'Updated new client with IG profile data',
        );
      })
      .catch((err) => {
        // Non-critical - we have igUserId as fallback identifier
        app.log.warn({ err, clientId: client.id }, 'Failed to save IG profile (non-fatal)');
      });
  }

  // ── Find or create conversation ──
  // B.3: if the active bot-state conversation is older than the tenant's
  // session-freshness window, close it and start fresh. A new session
  // lets the agent greet properly and keeps analytics (TTFR, brief
  // completeness, future quality rating) scoped per-sales-cycle rather
  // than smeared across months of idle chat. Handoff-state threads are
  // left alone — someone (or the manager queue) is owning that flow.
  let conversation = await prisma.conversation.findFirst({
    where: {
      clientId: client.id,
      channel: 'ig',
      state: { in: ['bot', 'handoff'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (conversation && conversation.state === 'bot' && conversation.lastMessageAt) {
    const { sessionFreshnessDays } = await getAgentConfig();
    const staleMs = sessionFreshnessDays * 86400000;
    if (Date.now() - conversation.lastMessageAt.getTime() > staleMs) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: 'closed' },
      });
      app.log.info(
        {
          conversationId: conversation.id,
          igUserId,
          ageDays: Math.round(
            (Date.now() - conversation.lastMessageAt.getTime()) / 86400000,
          ),
          sessionFreshnessDays,
        },
        'Closed stale conversation — starting fresh session',
      );
      conversation = null;
    }
  }

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        clientId: client.id,
        channel: 'ig',
        state: 'bot',
      },
    });
    app.log.info(
      { conversationId: conversation.id, igUserId },
      'Created new conversation',
    );
  }

  // ── Create message record ──
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'in',
      sender: 'client',
      text: redacted || null,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      // Store raw shared post metadata for audit / future reference.
      // Cast via unknown: Prisma's InputJsonValue is a recursive union that doesn't
      // accept typed interfaces with optional fields directly.
      sharedPost: sharedPost
        ? (sharedPost as unknown as Record<string, string | undefined>)
        : undefined,
      igMessageId,
    },
  });

  // ── Update conversation lastMessageAt (+ firstInboundAt on first ever inbound) ──
  // Prisma has no "coalesce on null" shorthand, so we branch in JS: set
  // firstInboundAt only when it's currently unset. Extra roundtrip is
  // already implicit in the surrounding flow (no hot loop here).
  const now = new Date();
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: now,
      ...(conversation.firstInboundAt ? {} : { firstInboundAt: now }),
    },
  });

  app.log.info(
    {
      igUserId,
      igMessageId,
      conversationId: conversation.id,
      hasSharedPost: !!sharedPost,
      mediaCount: mediaUrls.length,
    },
    'Persisted incoming Instagram message',
  );

  // Enqueue Claude turn asynchronously (don't await - webhook already responded)
  handleIncomingMessage(
    conversation.id,
    redacted || '',
    mediaUrls,
    sharedPost ?? undefined,
  ).catch((err) => {
    app.log.error({ err, conversationId: conversation.id }, 'Error in conversation handler');
  });
}
