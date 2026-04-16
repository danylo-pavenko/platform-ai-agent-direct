import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { sendText } from '../services/instagram.js';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // GET / — List conversations
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
          { igUserId: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [data, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          client: { select: { id: true, igUserId: true, displayName: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    return { data, total, page, limit };
  });

  // GET /:id — Get conversation detail with messages
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

    return conversation;
  });

  // POST /:id/reply — Manual reply from admin
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

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    return message;
  });
}
