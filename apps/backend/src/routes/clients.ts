import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { buildClientSearchWhere } from '../lib/client-directory.js';

function appointmentServiceLabel(services: unknown): string {
  if (!Array.isArray(services)) return '';
  return services
    .map((row) => {
      if (!row || typeof row !== 'object') return '';
      const name = (row as { name?: unknown }).name;
      return typeof name === 'string' ? name.trim() : '';
    })
    .filter(Boolean)
    .join(', ');
}

const clientListSelect = {
  id: true,
  displayName: true,
  igFullName: true,
  igUsername: true,
  phone: true,
  email: true,
  tags: true,
  crmBuyerId: true,
  crmProvider: true,
  lastActivityAt: true,
  createdAt: true,
  _count: { select: { conversations: true, orders: true } },
} as const;

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { search?: string; page?: string; limit?: string };
  }>('/', { onRequest: [app.authenticate] }, async (request) => {
    const search = request.query.search?.trim() ?? '';
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(request.query.limit ?? '20', 10) || 20));
    const where = buildClientSearchWhere(search);

    const [rows, total] = await Promise.all([
      prisma.client.findMany({
        where,
        select: clientListSelect,
        orderBy: { lastActivityAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.client.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        igFullName: row.igFullName,
        igUsername: row.igUsername,
        phone: row.phone,
        email: row.email,
        tags: row.tags,
        crmLinked: Boolean(row.crmBuyerId),
        crmProvider: row.crmProvider,
        lastActivityAt: row.lastActivityAt,
        createdAt: row.createdAt,
        conversationCount: row._count.conversations,
        orderCount: row._count.orders,
      })),
      total,
      page,
      limit,
    };
  });

  app.get<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const client = await prisma.client.findUnique({
        where: { id: request.params.id },
        include: {
          conversations: {
            orderBy: { lastMessageAt: 'desc' },
            take: 30,
            select: {
              id: true,
              state: true,
              lastMessageAt: true,
              createdAt: true,
              _count: { select: { messages: true } },
            },
          },
          orders: {
            orderBy: { createdAt: 'desc' },
            take: 30,
            select: {
              id: true,
              kind: true,
              status: true,
              customerName: true,
              phone: true,
              quotedTotal: true,
              createdAt: true,
              conversationId: true,
              crmSyncStatus: true,
              isArchived: true,
            },
          },
          appointments: {
            orderBy: { createdAt: 'desc' },
            take: 8,
            select: {
              id: true,
              status: true,
              scheduledDate: true,
              scheduledTime: true,
              services: true,
            },
          },
          _count: { select: { conversations: true, orders: true, appointments: true } },
        },
      });

      if (!client) {
        return reply.code(404).send({ error: 'Client not found' });
      }

      const [openConversationCount, confirmedOrderCount] = await Promise.all([
        prisma.conversation.count({
          where: { clientId: client.id, state: { not: 'closed' } },
        }),
        prisma.order.count({
          where: { clientId: client.id, status: 'confirmed' },
        }),
      ]);

      return {
        client: {
          id: client.id,
          displayName: client.displayName,
          igFullName: client.igFullName,
          igUsername: client.igUsername,
          phone: client.phone,
          email: client.email,
          notes: client.notes,
          tags: client.tags,
          preferredLanguage: client.preferredLanguage,
          crmLinked: Boolean(client.crmBuyerId),
          crmProvider: client.crmProvider,
          crmLinkedAt: client.crmLinkedAt,
          lastActivityAt: client.lastActivityAt,
          createdAt: client.createdAt,
        },
        insights: {
          conversationCount: client._count.conversations,
          openConversationCount,
          orderCount: client._count.orders,
          confirmedOrderCount,
          appointmentCount: client._count.appointments,
          lastActivityAt: client.lastActivityAt,
          crmLinked: Boolean(client.crmBuyerId),
          crmProvider: client.crmProvider,
        },
        conversations: client.conversations.map((c) => ({
          id: c.id,
          state: c.state,
          lastMessageAt: c.lastMessageAt,
          createdAt: c.createdAt,
          messageCount: c._count.messages,
        })),
        orders: client.orders,
        appointments: client.appointments.map((a) => ({
          id: a.id,
          status: a.status,
          scheduledDate: a.scheduledDate,
          scheduledTime: a.scheduledTime,
          servicesLabel: appointmentServiceLabel(a.services),
        })),
      };
    },
  );
}
