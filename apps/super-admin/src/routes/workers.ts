import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ensureLocalServer, isLocalServer } from '../lib/servers.js';
import { getWorkerClient } from '../lib/worker/client.js';
import { config } from '../config.js';

const createSchema = z.object({
  name: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, 'name: lowercase, digits, hyphen'),
  kind: z.enum(['remote']).default('remote'),
  baseUrl: z.string().url(),
  publicIp: z.string().min(3),
  sharedSecret: z.string().min(32).optional(),
  maxTenants: z.number().int().min(1).max(100).default(12),
});

const patchSchema = z.object({
  name: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/).optional(),
  baseUrl: z.string().url().nullable().optional(),
  publicIp: z.string().min(3).optional(),
  sharedSecret: z.string().min(32).nullable().optional(),
  maxTenants: z.number().int().min(1).max(100).optional(),
  status: z.enum(['active', 'draining', 'disabled']).optional(),
});

function publicServer(row: {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  publicIp: string;
  sharedSecret: string | null;
  maxTenants: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { tenants: number };
}) {
  const { sharedSecret, ...rest } = row;
  return {
    ...rest,
    hasSecret: Boolean(sharedSecret),
    tenantCount: row._count?.tenants ?? undefined,
  };
}

export async function workersRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] };

  app.get('/api/workers', auth, async () => {
    await ensureLocalServer();
    const rows = await prisma.server.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { tenants: true } } },
    });
    return rows.map(publicServer);
  });

  app.get<{ Params: { id: string } }>('/api/workers/:id', auth, async (req, reply) => {
    const row = await prisma.server.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { tenants: true } } },
    });
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return publicServer(row);
  });

  app.post('/api/workers', auth, async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({
        error: body.error.issues.map((i) => i.message).join('; '),
      });
    }

    if (body.data.name === 'local') {
      return reply.status(400).send({ error: 'Name «local» is reserved' });
    }

    const secret = body.data.sharedSecret || randomBytes(32).toString('hex');

    try {
      const created = await prisma.server.create({
        data: {
          name: body.data.name,
          kind: 'remote',
          baseUrl: body.data.baseUrl.replace(/\/$/, ''),
          publicIp: body.data.publicIp,
          sharedSecret: secret,
          maxTenants: body.data.maxTenants,
          status: 'active',
        },
      });
      return reply.status(201).send({
        ...publicServer({ ...created, _count: { tenants: 0 } }),
        sharedSecret: secret,
        bootstrapHint: [
          `# On the worker VPS (as root):`,
          `# 1) bash infra/scripts/provision-server.sh`,
          `# 2) bash infra/scripts/provision-platform-worker.sh`,
          `# 3) Set in worker .env:`,
          `WORKER_SHARED_SECRET=${secret}`,
          `# 4) PM2 start PW-api; allow SA IP to reach ${body.data.baseUrl}`,
          `# 5) Super Admin → Workers → Test`,
        ].join('\n'),
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.status(409).send({ error: 'Worker name already exists' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/workers/:id', auth, async (req, reply) => {
    const body = patchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({
        error: body.error.issues.map((i) => i.message).join('; '),
      });
    }

    const existing = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    if (isLocalServer(existing) && body.data.name && body.data.name !== 'local') {
      return reply.status(400).send({ error: 'Cannot rename local worker' });
    }

    const data: Record<string, unknown> = { ...body.data };
    if (typeof data.baseUrl === 'string') data.baseUrl = data.baseUrl.replace(/\/$/, '');
    if (data.sharedSecret === null && !isLocalServer(existing)) {
      return reply.status(400).send({ error: 'Cannot clear secret on remote worker' });
    }

    const updated = await prisma.server.update({
      where: { id: req.params.id },
      data,
      include: { _count: { select: { tenants: true } } },
    });
    return publicServer(updated);
  });

  app.delete<{ Params: { id: string } }>('/api/workers/:id', auth, async (req, reply) => {
    const existing = await prisma.server.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { tenants: true } } },
    });
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    if (isLocalServer(existing)) {
      return reply.status(400).send({ error: 'Cannot delete local worker' });
    }
    if (existing._count.tenants > 0) {
      return reply.status(409).send({
        error: `Worker still has ${existing._count.tenants} tenant(s)`,
      });
    }
    await prisma.server.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/workers/:id/test', auth, async (req, reply) => {
    const server = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!server) return reply.status(404).send({ error: 'Not found' });
    try {
      const client = getWorkerClient(server);
      const health = await client.healthCheck();
      let portsSample: number[] = [];
      try {
        portsSample = (await client.listListeningPorts()).slice(0, 8);
      } catch {
        // optional
      }
      return {
        ok: health.ok,
        health,
        portsSample,
        saPublicUrlConfigured: Boolean(config.SA_PUBLIC_URL),
      };
    } catch (err: any) {
      return reply.status(502).send({
        ok: false,
        error: err.message ?? 'Worker unreachable',
      });
    }
  });
}
