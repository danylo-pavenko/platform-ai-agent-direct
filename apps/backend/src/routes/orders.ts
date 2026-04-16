import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // GET / — List orders
  app.get<{
    Querystring: {
      status?: string;
      page?: string;
      limit?: string;
    };
  }>('/', { onRequest: [app.authenticate] }, async (request) => {
    const status = request.query.status;
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (status) {
      where.status = status;
    }

    const [data, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          client: { select: { id: true, igUserId: true, displayName: true } },
          conversation: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { data, total, page, limit };
  });

  // GET /:id — Get single order detail
  app.get<{
    Params: { id: string };
  }>('/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const order = await prisma.order.findUnique({
      where: { id: request.params.id },
      include: {
        client: true,
        conversation: true,
      },
    });

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    return order;
  });
}
