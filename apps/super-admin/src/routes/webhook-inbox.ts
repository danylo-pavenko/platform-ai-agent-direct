import type { FastifyInstance } from 'fastify';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';

function toPublic(row: {
  id: string;
  receivedAt: Date;
  kind: string;
  objectType: string | null;
  status: string;
  routingCandidateIds: unknown;
  debugCandidateIds: unknown;
  entrySummary: unknown;
  matchedTenantIds: unknown;
  forwardResults: unknown;
  signaturePresent: boolean;
  rawBodyTruncated: string | null;
  createdAt: Date;
}, includeRaw: boolean) {
  return {
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    kind: row.kind,
    objectType: row.objectType,
    status: row.status,
    routingCandidateIds: row.routingCandidateIds,
    debugCandidateIds: row.debugCandidateIds,
    entrySummary: row.entrySummary,
    matchedTenantIds: row.matchedTenantIds,
    forwardResults: row.forwardResults,
    signaturePresent: row.signaturePresent,
    rawBodyTruncated: includeRaw ? row.rawBodyTruncated : undefined,
    hasRaw: Boolean(row.rawBodyTruncated),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function webhookInboxRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] };

  app.get<{
    Querystring: { limit?: string; status?: string; q?: string };
  }>('/api/webhook-inbox', auth, async (req) => {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
    const status = (req.query.status || '').trim();
    const q = (req.query.q || '').trim();

    const where: Prisma.WebhookInboxEventWhereInput = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { objectType: { contains: q, mode: 'insensitive' } },
        { status: { contains: q, mode: 'insensitive' } },
        { kind: { contains: q, mode: 'insensitive' } },
        { rawBodyTruncated: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.webhookInboxEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: limit,
      }),
      prisma.webhookInboxEvent.count({ where }),
    ]);

    return {
      total,
      limit,
      data: rows.map((r) => toPublic(r, false)),
    };
  });

  app.get<{ Params: { id: string } }>('/api/webhook-inbox/:id', auth, async (req, reply) => {
    const row = await prisma.webhookInboxEvent.findUnique({ where: { id: req.params.id } });
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return toPublic(row, true);
  });

  app.delete('/api/webhook-inbox', auth, async () => {
    const result = await prisma.webhookInboxEvent.deleteMany({});
    return { ok: true, deleted: result.count };
  });
}
