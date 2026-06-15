import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const updateLeadSchema = z.object({
  status: z.enum(['new', 'contacted', 'closed', 'spam']).optional(),
});

export async function leadsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/leads', { onRequest: [app.authenticate] }, async (req) => {
    const q = req.query as { status?: string; linkId?: string; limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '100', 10) || 100, 1), 500);

    const leads = await prisma.landingLead.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.linkId ? { linkId: q.linkId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        link: { select: { id: true, name: true, slug: true } },
      },
    });

    const [total, byStatus] = await Promise.all([
      prisma.landingLead.count(),
      prisma.landingLead.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    return {
      leads,
      summary: {
        total,
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      },
    };
  });

  app.get('/api/leads/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lead = await prisma.landingLead.findUnique({
      where: { id },
      include: { link: { select: { id: true, name: true, slug: true } } },
    });
    if (!lead) return reply.status(404).send({ error: 'Not found' });
    return lead;
  });

  app.patch('/api/leads/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid data', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const lead = await prisma.landingLead.update({
        where: { id },
        data: parsed.data,
        include: { link: { select: { id: true, name: true, slug: true } } },
      });
      return lead;
    } catch {
      return reply.status(404).send({ error: 'Not found' });
    }
  });
}
