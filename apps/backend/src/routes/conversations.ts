import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { sendText } from '../services/instagram.js';
import { importIgConversationHistory } from '../services/ig-history.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import { dedupeConversationMessages } from '../lib/message-dedupe.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { fetchClientCrmHistory, linkClientToCrm } from '../services/client-crm-link.js';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // GET / - List conversations
  app.get<{
    Querystring: {
      state?: 'bot' | 'handoff' | 'closed';
      search?: string;
      page?: string;
      limit?: string;
    };
  }>('/', { onRequest: [app.authenticate] }, async (request) => {
    const state = request.query.state;
    const search = request.query.search;
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (state) {
      where.state = state;
    }

    if (search) {
      where.client = {
        OR: [
          { displayName: { contains: search, mode: 'insensitive' } },
          { igFullName: { contains: search, mode: 'insensitive' } },
          { igUsername: { contains: search, mode: 'insensitive' } },
          { igUserId: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          client: {
            select: {
              id: true,
              igUserId: true,
              displayName: true,
              igFullName: true,
              igUsername: true,
            },
          },
          // Fetch just one manager message (if any) to flag "manager already replied"
          messages: {
            where: { sender: 'manager' },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    const data = rows.map((c) => {
      const { messages, ...rest } = c;
      return { ...rest, hasManagerReply: messages.length > 0 };
    });

    return { data, total, page, limit };
  });

  // GET /:id/live — lightweight poll for admin: new messages since `after` + fresh client & meta.
  // Registered before `/:id` so "live" is not captured as a UUID param.
  app.get<{
    Params: { id: string };
    Querystring: { after?: string };
  }>('/:id/live', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    let afterDate: Date | undefined;
    const afterRaw = request.query.after;
    if (typeof afterRaw === 'string' && afterRaw.trim().length > 0) {
      const d = new Date(afterRaw.trim());
      if (!Number.isNaN(d.getTime())) afterDate = d;
    }

    const row = await prisma.conversation.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!row) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const newMessagesRaw = afterDate
      ? await prisma.message.findMany({
          where: { conversationId: id, createdAt: { gt: afterDate } },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const newMessages = dedupeConversationMessages(newMessagesRaw);

    return {
      conversation: {
        id: row.id,
        channel: row.channel,
        state: row.state,
        intent: row.intent,
        handoffReason: row.handoffReason,
        lastMessageAt: row.lastMessageAt,
        firstInboundAt: row.firstInboundAt,
        createdAt: row.createdAt,
        briefQuality: row.briefQuality,
        briefQualityNote: row.briefQualityNote,
      },
      client: row.client,
      newMessages,
    };
  });

  // GET /:id - Get conversation detail with messages
  app.get<{
    Params: { id: string };
  }>('/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const conversation = await prisma.conversation.findUnique({
      where: { id: request.params.id },
      include: {
        client: true,
        messages: { orderBy: { createdAt: 'asc' } },
        orders: true,
      },
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    return {
      ...conversation,
      messages: dedupeConversationMessages(conversation.messages),
    };
  });

  // POST /:id/reply - Manual reply from admin
  app.post<{
    Params: { id: string };
    Body: { text: string };
  }>('/:id/reply', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { text } = request.body ?? {};

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return reply.code(400).send({ error: 'Text is required' });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: request.params.id },
      include: { client: true },
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    if (!conversation.client.igUserId) {
      return reply.code(400).send({ error: 'Client has no Instagram user ID' });
    }

    // Send via Instagram
    await sendText(conversation.client.igUserId, text.trim());

    // Persist message
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'out',
        sender: 'manager',
        text: text.trim(),
      },
    });

    // Manager reply takes over the thread — abort any in-flight bot turn.
    const now = new Date();
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: now,
        ...(conversation.state === 'bot'
          ? {
              state: 'handoff',
              handoffReason: 'Менеджер відповів з адмінки',
              handedOffAt: now,
            }
          : {}),
        ...(conversation.firstOutboundAt ? {} : { firstOutboundAt: now }),
      },
    });

    return message;
  });

  // POST /:id/import-ig-history - Import historical IG messages from Graph API
  app.post<{
    Params: { id: string };
  }>('/:id/import-ig-history', { onRequest: [app.authenticate] }, async (request, reply) => {
    const conversation = await prisma.conversation.findUnique({
      where: { id: request.params.id },
      include: { client: true },
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    if (!conversation.client.igUserId) {
      return reply.code(400).send({ error: 'Client has no Instagram user ID' });
    }

    const result = await importIgConversationHistory(
      conversation.id,
      conversation.client.igUserId,
    );

    return result;
  });

  // POST /:id/brief-quality - Manager rates the lead / conversation quality
  //
  // Rating is 1–5 (or null to clear), with an optional free-form note.
  // Persisted on the Conversation row so B.3's context-carry-over gate
  // (R6: briefQuality ≥ 3) has something real to check against, and the
  // dashboard can expose avg lead quality per period.
  app.post<{
    Params: { id: string };
    Body: { quality: number | null; note?: string | null };
  }>('/:id/brief-quality', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { quality, note } = request.body ?? { quality: null };

    if (quality !== null && quality !== undefined) {
      if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 1 || quality > 5) {
        return reply.code(400).send({ error: 'quality must be an integer between 1 and 5, or null' });
      }
    }

    const trimmedNote =
      typeof note === 'string' && note.trim().length > 0 ? note.trim() : null;

    const existing = await prisma.conversation.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });
    if (!existing) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const updated = await prisma.conversation.update({
      where: { id: request.params.id },
      data: {
        briefQuality: quality ?? null,
        briefQualityNote: trimmedNote,
      },
      select: {
        id: true,
        briefQuality: true,
        briefQualityNote: true,
      },
    });

    return updated;
  });

  // PATCH /:id/bot-responses — enable/disable bot replies for this conversation
  app.patch<{
    Params: { id: string };
    Body: { enabled: boolean };
  }>('/:id/bot-responses', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { enabled } = request.body ?? {};

    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' });
    }

    const existing = await prisma.conversation.findUnique({
      where: { id: request.params.id },
      select: { id: true, state: true },
    });
    if (!existing) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const now = new Date();
    const updated = await prisma.conversation.update({
      where: { id: request.params.id },
      data: enabled
        ? {
            state: 'bot',
            handoffReason: null,
            handedOffAt: null,
            handedOffTo: null,
          }
        : {
            state: 'paused',
          },
      select: {
        id: true,
        state: true,
        handoffReason: true,
        handedOffAt: true,
      },
    });

    await prisma.message.create({
      data: {
        conversationId: updated.id,
        direction: 'system',
        sender: 'system',
        text: enabled
          ? 'Менеджер увімкнув відповіді бота для цієї розмови'
          : 'Менеджер вимкнув відповіді бота для цієї розмови',
        createdAt: now,
      },
    });

    return updated;
  });

  // PUT /clients/:clientId - Manually update client profile from admin
  app.put<{
    Params: { clientId: string };
    Body: {
      displayName?: string;
      phone?: string;
      email?: string;
      deliveryCity?: string;
      deliveryNpBranch?: string;
      deliveryNpType?: string;
      notes?: string;
      tags?: string[];
      crmBuyerId?: string | null;
    };
  }>('/clients/:clientId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { clientId } = request.params;
    const body = request.body ?? {};

    const allowedFields = [
      'displayName',
      'phone',
      'email',
      'deliveryCity',
      'deliveryNpBranch',
      'deliveryNpType',
      'notes',
      'tags',
    ];
    const update: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (field in body) {
        const val = (body as Record<string, unknown>)[field];
        if (val !== undefined) {
          update[field] = val === '' ? null : val;
        }
      }
    }

    // Manual CRM id from admin form (optional)
    if ('crmBuyerId' in body) {
      const raw = body.crmBuyerId;
      if (raw === null || raw === '') {
        update.crmBuyerId = null;
        update.crmProvider = null;
        update.crmLinkedAt = null;
      } else if (typeof raw === 'string' && raw.trim()) {
        const provider = await resolveCrmProvider('booking');
        update.crmBuyerId = raw.trim();
        update.crmProvider = provider;
        update.crmLinkedAt = new Date();
      }
    }

    if (Object.keys(update).length === 0) {
      return reply.code(400).send({ error: 'No fields to update' });
    }

    const before = await prisma.client.findUnique({
      where: { id: clientId },
      select: { phone: true },
    });

    const client = await prisma.client.update({
      where: { id: clientId },
      data: update,
    }).catch(() => null);

    if (!client) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    const phoneChanged =
      typeof update.phone === 'string' &&
      update.phone &&
      update.phone !== before?.phone;
    if (phoneChanged || (client.phone && !client.crmBuyerId)) {
      await linkClientToCrm(clientId, { upsert: false }).catch(() => undefined);
      const refreshed = await prisma.client.findUnique({ where: { id: clientId } });
      return refreshed ?? client;
    }

    return client;
  });

  // POST /clients/:clientId/crm-link — find by phone or attach explicit id
  app.post<{
    Params: { clientId: string };
    Body: { crmBuyerId?: string };
  }>('/clients/:clientId/crm-link', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { clientId } = request.params;
    const exists = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true },
    });
    if (!exists) return reply.code(404).send({ error: 'Client not found' });

    const crmBuyerId =
      typeof request.body?.crmBuyerId === 'string' && request.body.crmBuyerId.trim()
        ? request.body.crmBuyerId.trim()
        : undefined;

    const result = await linkClientToCrm(
      clientId,
      crmBuyerId ? { crmBuyerId, upsert: false } : { upsert: false },
    );

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    return { ...result, client };
  });

  // DELETE /clients/:clientId/crm-link — unlink
  app.delete<{ Params: { clientId: string } }>(
    '/clients/:clientId/crm-link',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { clientId } = request.params;
      const exists = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: 'Client not found' });

      const result = await linkClientToCrm(clientId, { crmBuyerId: null });
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      return { ...result, client };
    },
  );

  // GET /clients/:clientId/crm-history
  app.get<{ Params: { clientId: string } }>(
    '/clients/:clientId/crm-history',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { clientId } = request.params;
      const exists = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: 'Client not found' });

      const history = await fetchClientCrmHistory(clientId, { limit: 20 });
      return history;
    },
  );
}
