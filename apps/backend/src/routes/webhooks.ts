import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { verifyIgSignature } from '../lib/ig-signature.js';
import { sanitizeMessage, detectInjection, redactSensitive } from '../lib/sanitize.js';
import { handleIncomingMessage } from '../services/conversation.js';

// ── Meta webhook payload types (subset we care about) ──

interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: Array<{ type: string; payload?: { url?: string } }>;
  };
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

    if (
      mode === 'subscribe' &&
      token === config.IG_WEBHOOK_VERIFY_TOKEN
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

    if (!verifyIgSignature(rawBody, signature, config.META_APP_SECRET)) {
      app.log.warn('Invalid Instagram webhook signature');
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Return 200 immediately — Meta requires response within 5 seconds
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
        // Not a message event (e.g. delivery, read receipt) — skip
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
  const attachments = message.attachments;

  // ── Deduplicate by ig_message_id ──
  const existingMessage = await prisma.message.findUnique({
    where: { igMessageId },
  });

  if (existingMessage) {
    app.log.debug({ igMessageId }, 'Duplicate message — skipping');
    return;
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

  // ── Upsert client ──
  const client = await prisma.client.upsert({
    where: { igUserId },
    update: { lastActivityAt: new Date() },
    create: {
      igUserId,
      lastActivityAt: new Date(),
    },
  });

  // ── Find or create conversation ──
  let conversation = await prisma.conversation.findFirst({
    where: {
      clientId: client.id,
      channel: 'ig',
      state: { in: ['bot', 'handoff'] },
    },
    orderBy: { createdAt: 'desc' },
  });

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

  // ── Extract media URLs ──
  const mediaUrls = attachments
    ?.map((a) => a.payload?.url)
    .filter((url): url is string => !!url);

  // ── Create message record ──
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'in',
      sender: 'client',
      text: redacted || null,
      mediaUrls: mediaUrls && mediaUrls.length > 0 ? mediaUrls : undefined,
      igMessageId,
    },
  });

  // ── Update conversation lastMessageAt ──
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  app.log.info(
    { igUserId, igMessageId, conversationId: conversation.id },
    'Persisted incoming Instagram message',
  );

  // Enqueue Claude turn asynchronously (don't await — webhook already responded)
  handleIncomingMessage(
    conversation.id,
    redacted || '',
    mediaUrls,
  ).catch((err) => {
    app.log.error({ err, conversationId: conversation.id }, 'Error in conversation handler');
  });
}
