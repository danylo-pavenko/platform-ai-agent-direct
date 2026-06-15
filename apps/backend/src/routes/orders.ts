import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteReady } from '../lib/crm-write.js';
import { computeOrderTotal } from '../lib/order-totals.js';
import { keycrmOrderAppUrl } from '../lib/keycrm-urls.js';
import { mirrorOrderToCrm } from '../services/crm-sync.js';

function serializeOrder(
  order: {
    id: string;
    conversationId: string;
    clientId: string;
    items: unknown;
    customerName: string;
    phone: string;
    city: string;
    npBranch: string;
    paymentMethod: string;
    note: string | null;
    status: string;
    submittedToManagerAt: Date | null;
    keycrmOrderId: string | null;
    crmSyncStatus: string;
    crmSyncError: string | null;
    crmSyncedAt: Date | null;
    isArchived: boolean;
    archivedAt: Date | null;
    createdAt: Date;
    client?: { id: string; igUserId: string | null; displayName: string | null } | null;
    conversation?: { id: string } | null;
  },
) {
  return {
    ...order,
    total: computeOrderTotal(order.items),
    keycrmOrderUrl: order.keycrmOrderId ? keycrmOrderAppUrl(order.keycrmOrderId) : null,
    client: order.client?.displayName
      ?? (order.client?.igUserId ? `IG ${order.client.igUserId.slice(-6)}` : '—'),
    clientId: order.client?.id ?? order.clientId,
    conversationId: order.conversation?.id ?? order.conversationId,
  };
}

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // GET / - List orders
  app.get<{
    Querystring: {
      status?: string;
      page?: string;
      limit?: string;
      includeArchived?: string;
    };
  }>('/', { onRequest: [app.authenticate] }, async (request) => {
    const status = request.query.status;
    const includeArchived = request.query.includeArchived === 'true';
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (!includeArchived) {
      where.isArchived = false;
    }

    if (status) {
      where.status = status;
    }

    const [rows, total] = await Promise.all([
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

    return {
      data: rows.map(serializeOrder),
      total,
      page,
      limit,
    };
  });

  // GET /:id - Get single order detail
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

    return serializeOrder(order);
  });

  // POST /:id/sync-crm - Manual CRM mirror retry
  app.post<{
    Params: { id: string };
  }>('/:id/sync-crm', { onRequest: [app.authenticate] }, async (request, reply) => {
    const order = await prisma.order.findUnique({
      where: { id: request.params.id },
      select: { id: true, keycrmOrderId: true },
    });

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    if (order.keycrmOrderId) {
      return {
        ok: true,
        alreadySynced: true,
        keycrmOrderId: order.keycrmOrderId,
      };
    }

    const writeReady = await isCrmWriteReady();
    if (!writeReady.ready) {
      return reply.code(400).send({
        error: writeReady.reason ?? 'CRM write not available',
        crmWrite: writeReady,
      });
    }

    try {
      await mirrorOrderToCrm(order.id);
      const updated = await prisma.order.findUnique({
        where: { id: order.id },
        select: {
          keycrmOrderId: true,
          crmSyncStatus: true,
          crmSyncError: true,
          crmSyncedAt: true,
        },
      });

      if (updated?.crmSyncStatus !== 'synced') {
        return reply.code(502).send({
          error: updated?.crmSyncError ?? 'CRM mirror failed',
          crmSyncStatus: updated?.crmSyncStatus,
        });
      }

      return {
        ok: true,
        keycrmOrderId: updated.keycrmOrderId,
        crmSyncStatus: updated.crmSyncStatus,
        crmSyncedAt: updated.crmSyncedAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });
}
