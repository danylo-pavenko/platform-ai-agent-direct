import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const prisma = new PrismaClient();

const tenantSchema = z.object({
  instanceId: z.string().min(1).max(10).regex(/^[a-z0-9]+$/),
  name: z.string().min(1),
  apiDomain: z.string().min(1),
  adminDomain: z.string().min(1),
  apiPort: z.number().int().min(1024).max(65535),
  adminPort: z.number().int().min(1024).max(65535),
  linuxUser: z.string().min(1),
  appDir: z.string().min(1),
  status: z.enum(['provisioned', 'active', 'suspended']).default('provisioned'),
});

export async function tenantsRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] };

  // List all tenants
  app.get('/api/tenants', auth, async () => {
    return prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
  });

  // Get single tenant
  app.get<{ Params: { id: string } }>('/api/tenants/:id', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });
    return tenant;
  });

  // Create tenant
  app.post('/api/tenants', auth, async (req, reply) => {
    const body = tenantSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const tenant = await prisma.tenant.create({ data: body.data });
    return reply.status(201).send(tenant);
  });

  // Update tenant
  app.put<{ Params: { id: string } }>('/api/tenants/:id', auth, async (req, reply) => {
    const body = tenantSchema.partial().safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: body.data,
    });
    return tenant;
  });

  // Delete tenant
  app.delete<{ Params: { id: string } }>('/api/tenants/:id', auth, async (req, reply) => {
    await prisma.tenant.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // Health check for tenant
  app.get<{ Params: { id: string } }>('/api/tenants/:id/health', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    try {
      const res = await fetch(`http://localhost:${tenant.apiPort}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      return { online: res.ok, status: data };
    } catch {
      return { online: false, status: null };
    }
  });

  // Trigger deploy for tenant
  app.post<{ Params: { id: string } }>('/api/tenants/:id/deploy', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;
    const cmd = `sudo -u ${tenant.linuxUser} bash ${deployScript}`;

    app.log.info({ cmd }, 'Triggering deploy');
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 });
      return { ok: true, stdout: stdout.slice(-2000), stderr: stderr.slice(-500) };
    } catch (err: any) {
      app.log.error({ err }, 'Deploy failed');
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  // Proxy chat to tenant sandbox (for compact chat panel)
  app.post<{ Params: { id: string } }>('/api/tenants/:id/chat', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    try {
      const res = await fetch(`http://localhost:${tenant.apiPort}/sandbox/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(35_000),
      });
      const data = await res.json();
      return data;
    } catch (err: any) {
      return reply.status(502).send({ error: 'Tenant unreachable', detail: err.message });
    }
  });
}
