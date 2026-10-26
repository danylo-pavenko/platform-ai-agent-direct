import type { FastifyInstance } from 'fastify';
import {
  createTenantEvent,
  deleteTenantEvent,
  duplicateTenantEvent,
  getTenantEventById,
  listTenantEvents,
  tenantEventInputSchema,
  tenantEventUpdateSchema,
  updateTenantEvent,
} from '../services/tenant-events.js';

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  /** Managers: read active + recently relevant; owners: full list including archived via ?all=1 */
  app.get('/', { onRequest: [app.authenticate] }, async (request) => {
    const q = request.query as { all?: string };
    const isOwner = request.user?.role === 'owner';
    const includeArchived = isOwner && (q.all === '1' || q.all === 'true');
    const events = await listTenantEvents({ includeArchived });
    // Managers only see non-draft (context for shift)
    const filtered =
      isOwner ? events : events.filter((e) => e.status !== 'draft' && e.lifecycle !== 'hidden');
    return { events: filtered };
  });

  app.get<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const event = await getTenantEventById(request.params.id);
      if (!event) return reply.code(404).send({ error: 'Event not found' });
      if (request.user?.role !== 'owner' && event.status === 'draft') {
        return reply.code(404).send({ error: 'Event not found' });
      }
      return { event };
    },
  );

  app.post('/', { onRequest: [app.authenticate, app.requireOwner] }, async (request, reply) => {
    const parsed = tenantEventInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const event = await createTenantEvent(parsed.data);
    return { event };
  });

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const existing = await getTenantEventById(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Event not found' });
      const parsed = tenantEventUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const event = await updateTenantEvent(request.params.id, parsed.data);
      return { event };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/duplicate',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const event = await duplicateTenantEvent(request.params.id);
      if (!event) return reply.code(404).send({ error: 'Event not found' });
      return { event };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const existing = await getTenantEventById(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Event not found' });
      await deleteTenantEvent(request.params.id);
      return { ok: true };
    },
  );
}
