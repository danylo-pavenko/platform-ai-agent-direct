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
  gitRepo: z.string().min(1).optional(),
  envExtra: z.string().optional(),
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

  // Stream deploy logs via SSE (with auto-provision on first deploy)
  app.get<{ Params: { id: string } }>('/api/tenants/:id/deploy/stream', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });

    const send = (line: string) => reply.raw.write(`data: ${line}\n\n`);
    send(`[deploy started] ${tenant.name} (${tenant.instanceId})`);

    // Run a command, stream its output, return exit code
    const runStream = (args: string[], stdin?: string): Promise<number> =>
      new Promise((resolve) => {
        const child = spawn(args[0], args.slice(1), {
          stdio: stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        });
        if (stdin !== undefined) {
          (child.stdin as NodeJS.WritableStream).write(stdin);
          (child.stdin as NodeJS.WritableStream).end();
        }
        child.stdout?.on('data', (chunk: Buffer) => {
          chunk.toString().split('\n').forEach((l) => { if (l.trim()) send(l); });
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          chunk.toString().split('\n').forEach((l) => { if (l.trim()) send(`[err] ${l}`); });
        });
        req.raw.on('close', () => child.kill());
        child.on('close', resolve);
        child.on('error', (err: Error) => { send(`[error] ${err.message}`); resolve(1); });
      });

    const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;

    // Check if project is already cloned
    const checkCode = await runStream(
      ['bash', '-c', `sudo -u ${tenant.linuxUser} test -f '${deployScript}'`],
    );

    if (checkCode !== 0) {
      // ── Auto-provision ──────────────────────────────────────────────────────
      if (!tenant.gitRepo) {
        send('[error] Git repo URL not configured. Edit the client and set Git Repo.');
        send('[✗ provision failed]');
        reply.raw.end();
        return;
      }

      send('[provision] Project not found — running initial setup...');

      // Build .env content from tenant fields + envExtra
      const envLines = [
        `INSTANCE_ID=${tenant.instanceId}`,
        `INSTANCE_NAME=${tenant.name}`,
        `API_DOMAIN=${tenant.apiDomain}`,
        `ADMIN_DOMAIN=${tenant.adminDomain}`,
        `API_PORT=${tenant.apiPort}`,
        `ADMIN_PORT=${tenant.adminPort}`,
        `APP_DIR=${tenant.appDir}`,
        `LINUX_USER=${tenant.linuxUser}`,
        tenant.envExtra?.trim() ?? '',
      ].filter(Boolean).join('\n');

      const envB64 = Buffer.from(envLines).toString('base64');

      // Provision script runs as root (sudo bash -s)
      const provisionScript = `
set -euo pipefail

TENANT_USER='${tenant.linuxUser}'
APP_DIR='${tenant.appDir}'
GIT_REPO='${tenant.gitRepo}'
# Current user home (agentsadmin)
CURRENT_HOME=$(eval echo "~$(whoami)")
TENANT_HOME=$(eval echo "~$TENANT_USER")

# ── SSH setup ──
echo "[provision] Setting up .ssh for $TENANT_USER..."
mkdir -p "$TENANT_HOME/.ssh"
chown "$TENANT_USER:$TENANT_USER" "$TENANT_HOME/.ssh"
chmod 700 "$TENANT_HOME/.ssh"

if [ ! -f "$TENANT_HOME/.ssh/id_rsa" ] && [ -f "$CURRENT_HOME/.ssh/id_rsa" ]; then
  cp "$CURRENT_HOME/.ssh/id_rsa" "$TENANT_HOME/.ssh/id_rsa"
  cp "$CURRENT_HOME/.ssh/id_rsa.pub" "$TENANT_HOME/.ssh/id_rsa.pub" 2>/dev/null || true
  chown "$TENANT_USER:$TENANT_USER" "$TENANT_HOME/.ssh/id_rsa" "$TENANT_HOME/.ssh/id_rsa.pub" 2>/dev/null || true
  chmod 600 "$TENANT_HOME/.ssh/id_rsa"
  echo "[provision] SSH key copied from $(whoami)"
else
  echo "[provision] SSH key already exists or source not found — skipping"
fi

if [ -f "$CURRENT_HOME/.ssh/authorized_keys" ] && [ ! -f "$TENANT_HOME/.ssh/authorized_keys" ]; then
  cp "$CURRENT_HOME/.ssh/authorized_keys" "$TENANT_HOME/.ssh/authorized_keys"
  chown "$TENANT_USER:$TENANT_USER" "$TENANT_HOME/.ssh/authorized_keys"
  chmod 600 "$TENANT_HOME/.ssh/authorized_keys"
  echo "[provision] authorized_keys copied"
fi

# ── Clone repo ──
echo "[provision] Cloning $GIT_REPO..."
sudo -u "$TENANT_USER" bash -c "GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=no' git clone '$GIT_REPO' '$APP_DIR'"
echo "[provision] Repository cloned to $APP_DIR"

# ── Write .env (base64-encoded to avoid quoting issues) ──
echo "[provision] Writing .env..."
printf '%s' '${envB64}' | base64 -d > "$APP_DIR/.env"
chown "$TENANT_USER:$TENANT_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "[provision] .env written"

echo "[provision] ✓ Initial setup complete"
`.trim();

      app.log.info({ linuxUser: tenant.linuxUser }, 'Running provision script');
      const provisionCode = await runStream(['sudo', 'bash', '-s'], provisionScript);

      if (provisionCode !== 0) {
        send('[✗ provision failed — check errors above]');
        reply.raw.end();
        return;
      }
      send('[provision] Starting deploy...');
    }

    // ── Deploy ──────────────────────────────────────────────────────────────
    app.log.info({ deployScript }, 'Running deploy-client.sh');
    const deployCode = await runStream([
      'bash', '-c', `sudo -u ${tenant.linuxUser} bash '${deployScript}'`,
    ]);

    send(deployCode === 0
      ? '[✓ deploy finished successfully]'
      : `[✗ deploy failed with exit code ${deployCode}]`);
    reply.raw.end();
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
