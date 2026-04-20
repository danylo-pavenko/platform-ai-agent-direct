import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { exec, spawn } from 'node:child_process';
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
  app.get('/api/tenants', auth, async (req, reply) => {
    try {
      return await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
    } catch (err: any) {
      app.log.error({ err }, 'Failed to fetch tenants');
      return reply.status(500).send({ error: 'DB error', detail: err.message });
    }
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

  // Trigger deploy for tenant (legacy non-streaming, kept for compat)
  app.post<{ Params: { id: string } }>('/api/tenants/:id/deploy', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;
    const cmd = `sudo -u ${tenant.linuxUser} bash ${deployScript}`;

    app.log.info({ cmd }, 'Triggering deploy');
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 300_000 });
      return { ok: true, stdout: stdout.slice(-2000), stderr: stderr.slice(-500) };
    } catch (err: any) {
      app.log.error({ err }, 'Deploy failed');
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  // Stream deploy logs via SSE
  app.get<{ Params: { id: string } }>('/api/tenants/:id/deploy/stream', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;
    const cmd = ['bash', '-c', `sudo -u ${tenant.linuxUser} bash ${deployScript}`];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });

    const send = (line: string) => {
      reply.raw.write(`data: ${line}\n\n`);
    };

    send(`[deploy started] ${tenant.name} (${tenant.instanceId})`);
    app.log.info({ cmd: cmd.join(' ') }, 'Streaming deploy');

    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });

    const pipeLines = (chunk: Buffer, prefix = '') => {
      chunk.toString().split('\n').forEach((line) => {
        if (line.trim()) send(prefix + line);
      });
    };

    child.stdout.on('data', (chunk: Buffer) => pipeLines(chunk));
    child.stderr.on('data', (chunk: Buffer) => pipeLines(chunk, '[err] '));

    // Abort stream if client disconnects
    req.raw.on('close', () => { child.kill(); });

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        send(code === 0 ? '[✓ deploy finished successfully]' : `[✗ deploy failed with exit code ${code}]`);
        reply.raw.end();
        resolve();
      });
      child.on('error', (err: Error) => {
        send(`[error] ${err.message}`);
        reply.raw.end();
        resolve();
      });
    });
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
