import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  collectTenantInstagramRoutingIds,
  mergeTenantInstagramRoutingIds,
  normalizeInstagramRoutingIds,
} from '../lib/tenant-webhook-routing.js';
import {
  INSTANCE_ID_RE,
  defaultAppDir,
  defaultLinuxUser,
  platformDefaultsForSlug,
  suggestNextPortPair,
} from '../lib/tenant-domains.js';
import { listLiveApiPorts } from '../lib/tenant-provision.js';
import { DEFAULT_TENANT_GIT_REPO } from '../lib/constants.js';
import { computeExtendedExpiry } from '../lib/tenant-access.js';
import {
  followDeployLog,
  getActiveDeployJob,
  getDeployJob,
  getLatestDeployJob,
  startDeployJob,
} from '../lib/deploy-job.js';

const execAsync = promisify(exec);

/** Platform monorepo — same for all tenants unless overridden in Server setup. */
export { DEFAULT_TENANT_GIT_REPO };

const tenantSchema = z.object({
  instanceId: z.string().regex(INSTANCE_ID_RE, 'instanceId: lowercase letters, digits, hyphen; 2–24 chars'),
  name: z.string().min(1),
  apiDomain: z.string().min(1),
  adminDomain: z.string().min(1),
  apiPort: z.number().int().min(1024).max(65535),
  adminPort: z.number().int().min(1024).max(65535),
  linuxUser: z.string().regex(/^[a-z0-9-]{2,24}$/),
  appDir: z.string().min(1).regex(/^\/home\/[a-z0-9-]+\/platform-ai-agent-direct$/),
  status: z.enum(['provisioned', 'active', 'suspended']).default('provisioned'),
  gitRepo: z.union([z.literal(''), z.string().min(1)]).optional(),
  envExtra: z.string().optional(),
  // Instagram / Meta webhook routing
  instagramUserId: z.union([z.literal(''), z.string().regex(/^\d+$/)]).optional(),
  instagramRoutingIds: z.array(z.string().regex(/^\d+$/)).optional(),
  facebookAppSecret: z.string().optional(),
  // Admin-panel access: null = unlimited (default), ISO datetime = until then.
  // z.null() must come first — z.coerce.date() would coerce null to 1970.
  accessExpiresAt: z
    .union([z.null(), z.coerce.date()])
    .optional(),
});

const accessPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('unlimited') }),
  z.object({ action: z.literal('suspend') }),
  z.object({ action: z.literal('reactivate') }),
  z.object({
    action: z.literal('extend'),
    months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  }),
  z.object({ action: z.literal('set'), accessExpiresAt: z.coerce.date() }),
]);

// Single source of truth for the access decision, reused by the
// access endpoint and (later) by payment automation.
function resolveAccess(tenant: { status: string; accessExpiresAt: Date | null }) {
  if (tenant.status === 'suspended') {
    return { allowed: false, reason: 'suspended' as const };
  }
  if (tenant.accessExpiresAt && tenant.accessExpiresAt.getTime() <= Date.now()) {
    return { allowed: false, reason: 'expired' as const };
  }
  return { allowed: true, reason: null };
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'field'}: ${i.message}`).join('; ');
}

function formatPrismaError(err: unknown): { status: number; error: string } {
  const e = err as { code?: string; meta?: { target?: string[] }; message?: string };
  if (e.code === 'P2002') {
    const field = e.meta?.target?.join(', ') ?? 'unique field';
    return {
      status: 409,
      error: `Це значення вже використовується іншим клієнтом (${field}). Для webhook додайте ID у «Додаткові routing ID», не замінюйте основний.`,
    };
  }
  if (e.code === 'P2025') {
    return { status: 404, error: 'Клієнт не знайдено' };
  }
  const msg = e.message ?? 'Database error';
  if (msg.includes('instagram_routing_ids')) {
    return {
      status: 500,
      error:
        'Потрібна міграція БД super-admin: npx prisma migrate deploy (колонка instagram_routing_ids)',
    };
  }
  return { status: 500, error: msg };
}

function prepareTenantWriteData(
  input: z.infer<typeof tenantSchema> | Partial<z.infer<typeof tenantSchema>>,
) {
  const data: Record<string, unknown> = { ...input };

  if (typeof data.instanceId === 'string') {
    const slug = data.instanceId;
    if (!data.linuxUser) data.linuxUser = defaultLinuxUser(slug);
    if (!data.appDir) data.appDir = defaultAppDir(slug);
  }

  if (data.instagramUserId === '') data.instagramUserId = null;

  if (data.facebookAppSecret === '') delete data.facebookAppSecret;

  // Empty gitRepo on edit = leave unchanged; create path fills DEFAULT_TENANT_GIT_REPO below.
  if (data.gitRepo === '') delete data.gitRepo;

  if (data.instagramRoutingIds !== undefined) {
    const primary = typeof data.instagramUserId === 'string' ? data.instagramUserId : '';
    data.instagramRoutingIds = normalizeInstagramRoutingIds(
      primary,
      data.instagramRoutingIds as string[],
    );
  }

  return data;
}

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

  // Suggested platform hostnames + next free ports for the Add Client form.
  app.get<{ Querystring: { instanceId?: string } }>('/api/tenants/platform-defaults', auth, async (req, reply) => {
    const rawSlug = req.query.instanceId?.trim().toLowerCase() ?? '';
    const slugOk = rawSlug && INSTANCE_ID_RE.test(rawSlug);

    const rows = await prisma.tenant.findMany({
      select: { instanceId: true, name: true, apiPort: true, adminPort: true },
      orderBy: { apiPort: 'asc' },
    });
    const usedApiPorts = rows.map((r) => r.apiPort);
    let nextPorts: { apiPort: number; adminPort: number };
    let liveListeningPorts: number[] = [];
    try {
      const live = await listLiveApiPorts();
      const { PLATFORM_PORT_BASE, PLATFORM_PORT_MAX } = config;
      liveListeningPorts = live.filter((p) => p >= PLATFORM_PORT_BASE && p <= PLATFORM_PORT_MAX);
      nextPorts = suggestNextPortPair(usedApiPorts, live);
    } catch (err: any) {
      return reply.status(503).send({ error: err.message });
    }

    return {
      platformBaseDomain: config.PLATFORM_BASE_DOMAIN,
      nextPorts,
      portPolicy: {
        base: config.PLATFORM_PORT_BASE,
        step: config.PLATFORM_PORT_STEP,
        max: config.PLATFORM_PORT_MAX,
      },
      registeredPortPairs: rows,
      liveListeningPorts,
      ...(slugOk
        ? { slug: rawSlug, ...platformDefaultsForSlug(rawSlug) }
        : {}),
    };
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
    if (!body.success) {
      return reply.status(400).send({ error: formatZodError(body.error) });
    }

    try {
      const prepared = prepareTenantWriteData(body.data) as Record<string, unknown>;
      if (!prepared.gitRepo) prepared.gitRepo = DEFAULT_TENANT_GIT_REPO;

      const tenant = await prisma.tenant.create({
        data: prepared as Parameters<typeof prisma.tenant.create>[0]['data'],
      });
      return reply.status(201).send(tenant);
    } catch (err) {
      app.log.error({ err }, 'Failed to create tenant');
      const { status, error } = formatPrismaError(err);
      return reply.status(status).send({ error });
    }
  });

  // Update tenant
  app.put<{ Params: { id: string } }>('/api/tenants/:id', auth, async (req, reply) => {
    const body = tenantSchema.partial().safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: formatZodError(body.error) });
    }

    try {
      const tenant = await prisma.tenant.update({
        where: { id: req.params.id },
        data: prepareTenantWriteData(body.data) as Parameters<typeof prisma.tenant.update>[0]['data'],
      });
      return tenant;
    } catch (err) {
      app.log.error({ err }, 'Failed to update tenant');
      const { status, error } = formatPrismaError(err);
      return reply.status(status).send({ error });
    }
  });

  // Quick access regulation (subscription expiry / suspend).
  app.patch<{ Params: { id: string } }>('/api/tenants/:id/access', auth, async (req, reply) => {
    const body = accessPatchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: formatZodError(body.error) });
    }

    const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    let data: { accessExpiresAt?: Date | null; status?: string };

    switch (body.data.action) {
      case 'unlimited':
        data = { accessExpiresAt: null, status: 'active' };
        break;
      case 'suspend':
        data = { status: 'suspended' };
        break;
      case 'reactivate':
        data = { status: 'active' };
        break;
      case 'extend':
        data = {
          accessExpiresAt: computeExtendedExpiry(existing.accessExpiresAt, body.data.months),
          status: 'active',
        };
        break;
      case 'set':
        data = { accessExpiresAt: body.data.accessExpiresAt, status: 'active' };
        break;
    }

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data,
    });

    app.log.info(
      {
        tenantId: tenant.id,
        instanceId: tenant.instanceId,
        action: body.data.action,
        accessExpiresAt: tenant.accessExpiresAt?.toISOString() ?? null,
        status: tenant.status,
      },
      'Tenant access updated',
    );

    return {
      ...tenant,
      access: resolveAccess(tenant),
    };
  });

  // Delete tenant
  app.delete<{ Params: { id: string } }>('/api/tenants/:id', auth, async (req, reply) => {
    await prisma.tenant.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // Health check for tenant.
  // deployed: whether the project is already provisioned on disk
  // (deploy-client.sh exists in appDir) — lets the UI distinguish
  // "not deployed yet" from "deployed but offline".
  app.get<{ Params: { id: string } }>('/api/tenants/:id/health', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    let deployed: boolean | null = null;
    try {
      await execAsync(`getent passwd '${tenant.linuxUser.replace(/'/g, `'\\''`)}'`, { timeout: 5_000 });
    } catch {
      return { online: false, deployed: false, status: null };
    }

    try {
      await execAsync(
        `sudo -u ${tenant.linuxUser} test -f '${tenant.appDir}/infra/scripts/deploy-client.sh'`,
        { timeout: 10_000 },
      );
      deployed = true;
    } catch (err: any) {
      // `test -f` exits 1 with empty stderr when the file is genuinely
      // missing; sudo/permission problems and timeouts produce stderr or
      // other exit codes = unknown — don't mislabel a live instance.
      const stderr = String(err?.stderr ?? '').trim();
      deployed = err?.code === 1 && !stderr ? false : null;
    }

    try {
      const res = await fetch(`http://localhost:${tenant.apiPort}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      return { online: res.ok, deployed: deployed ?? res.ok, status: data };
    } catch {
      return { online: false, deployed, status: null };
    }
  });

  // Start deploy job (or return already-running job). Detached from HTTP lifetime.
  app.post<{ Params: { id: string } }>('/api/tenants/:id/deploy', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    try {
      const result = await startDeployJob(tenant.id);
      return {
        ok: true,
        started: result.started,
        job: result.job,
      };
    } catch (err: any) {
      app.log.error({ err }, 'Failed to start deploy job');
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  // Latest / active deploy job status for UI (button disable + reopen log).
  app.get<{ Params: { id: string } }>('/api/tenants/:id/deploy/status', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    const active = await getActiveDeployJob(tenant.id);
    const latest = active ?? (await getLatestDeployJob(tenant.id));
    return {
      running: Boolean(active),
      job: latest,
    };
  });

  // Stream deploy logs via SSE. Starts a job if none running; never kills on disconnect.
  app.get<{ Params: { id: string }; Querystring: { jobId?: string; fromEnd?: string } }>(
    '/api/tenants/:id/deploy/stream',
    auth,
    async (req, reply) => {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
      if (!tenant) return reply.status(404).send({ error: 'Not found' });

      let jobId = '';
      const rawJobId = req.query.jobId;
      if (typeof rawJobId === 'string' && rawJobId.trim()) {
        jobId = rawJobId.trim();
      } else if (Array.isArray(rawJobId) && typeof rawJobId[0] === 'string') {
        jobId = rawJobId[0].trim();
      }

      const fromEndRaw = req.query.fromEnd;
      const fromEnd =
        fromEndRaw === '1' ||
        fromEndRaw === 'true' ||
        (Array.isArray(fromEndRaw) && (fromEndRaw[0] === '1' || fromEndRaw[0] === 'true'));

      if (jobId) {
        const existing = await getDeployJob(jobId);
        if (!existing || existing.tenantId !== tenant.id) {
          return reply.status(404).send({ error: 'Deploy job not found' });
        }
      } else {
        const result = await startDeployJob(tenant.id);
        jobId = result.job.id;
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });

      let clientOpen = true;
      req.raw.on('close', () => {
        clientOpen = false;
      });

      const send = (line: string) => {
        if (!clientOpen) return;
        try {
          reply.raw.write(`data: ${line}\n\n`);
        } catch {
          clientOpen = false;
        }
      };

      const sendKeepalive = () => {
        if (!clientOpen) return;
        try {
          // SSE comment — keeps nginx/proxies from idle-closing the socket.
          reply.raw.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
          clientOpen = false;
        }
      };

      try {
        await followDeployLog(jobId, send, () => clientOpen, sendKeepalive, { fromEnd });
      } catch (err: any) {
        send(`[error] ${err?.message ?? err}`);
      }

      if (clientOpen) {
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      }
    },
  );

  // Proxy supervisor chat to tenant backend.
  // Accepts { message, history } from the UI and forwards as
  // { messages: [...] } to /supervisor/chat. Authenticated to the
  // tenant via the shared SUPERVISOR_SHARED_SECRET, never via a
  // tenant-admin JWT (super-admin does not own one).
  app.post<{
    Params: { id: string };
    Body: {
      message?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };
  }>('/api/tenants/:id/chat', auth, async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return reply.status(404).send({ error: 'Not found' });

    if (!config.SUPERVISOR_SHARED_SECRET) {
      return reply.status(503).send({
        error: 'SUPERVISOR_SHARED_SECRET is not set in super-admin .env',
      });
    }

    const { message, history } = req.body ?? {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return reply.status(400).send({ error: 'message is required' });
    }

    const priorHistory = Array.isArray(history) ? history : [];
    const messages = [
      ...priorHistory,
      { role: 'user' as const, content: message },
    ];

    try {
      const res = await fetch(`http://localhost:${tenant.apiPort}/supervisor/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET,
        },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(60_000),
      });

      const data: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        return reply.status(res.status).send({
          error: data?.error || `Tenant returned ${res.status}`,
        });
      }

      return data;
    } catch (err: any) {
      return reply.status(502).send({ error: 'Tenant unreachable', detail: err.message });
    }
  });

  // Auto-sync webhook routing config from tenant OAuth flow.
  // Called by the tenant backend after a successful Facebook OAuth so that
  // the platform hub can route webhooks to this tenant without manual setup.
  // Auth: X-Supervisor-Token (same shared secret used for /supervisor/* routes).
  app.post<{
    Params: { instanceId: string };
    Body: {
      instagramUserId: string;
      facebookAppSecret: string;
      instagramRoutingIds?: string[];
    };
  }>('/api/tenants/by-instance/:instanceId/webhook-config', async (req, reply) => {
    const token = req.headers['x-supervisor-token'];
    if (!config.SUPERVISOR_SHARED_SECRET || token !== config.SUPERVISOR_SHARED_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { instagramUserId, facebookAppSecret, instagramRoutingIds } = req.body ?? {};
    if (!instagramUserId || !facebookAppSecret) {
      return reply.status(400).send({ error: 'instagramUserId and facebookAppSecret are required' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { instanceId: req.params.instanceId } });
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    const synced = normalizeInstagramRoutingIds(instagramUserId, instagramRoutingIds);
    const routingIds = mergeTenantInstagramRoutingIds(tenant, synced, instagramUserId);
    const accountChanged = Boolean(tenant.instagramUserId && tenant.instagramUserId !== instagramUserId);

    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        instagramUserId,
        facebookAppSecret,
        instagramRoutingIds: routingIds,
      },
    });

    app.log.info(
      {
        instanceId: req.params.instanceId,
        instagramUserId,
        instagramRoutingIds: routingIds,
        accountChanged,
        droppedStaleRouting: accountChanged,
      },
      'Webhook config auto-synced from tenant OAuth',
    );

    return {
      ok: true,
      instagramUserId: updated.instagramUserId,
      instagramRoutingIds: updated.instagramRoutingIds,
    };
  });

  // Clear webhook routing config when the tenant disconnects their Instagram.
  // instagramUserId is unique, so it must be released for future (re)connects.
  // facebookAppSecret is kept — it belongs to the tenant's Meta App, not the page.
  app.delete<{
    Params: { instanceId: string };
  }>('/api/tenants/by-instance/:instanceId/webhook-config', async (req, reply) => {
    const token = req.headers['x-supervisor-token'];
    if (!config.SUPERVISOR_SHARED_SECRET || token !== config.SUPERVISOR_SHARED_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { instanceId: req.params.instanceId } });
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { instagramUserId: null, instagramRoutingIds: [] },
    });

    app.log.info(
      { instanceId: req.params.instanceId, previousInstagramUserId: tenant.instagramUserId },
      'Webhook config cleared after tenant Instagram disconnect',
    );

    return { ok: true };
  });

  // Access check for tenant admin panels.
  // Called by tenant backends (login + authenticated requests, cached) to learn
  // whether their admin panel is still allowed to operate. Auth via the same
  // shared secret used for the other by-instance endpoints.
  // null accessExpiresAt = unlimited access. status 'suspended' = hard block.
  app.get<{ Params: { instanceId: string } }>(
    '/api/tenants/by-instance/:instanceId/access',
    async (req, reply) => {
      const token = req.headers['x-supervisor-token'];
      if (!config.SUPERVISOR_SHARED_SECRET || token !== config.SUPERVISOR_SHARED_SECRET) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const tenant = await prisma.tenant.findUnique({
        where: { instanceId: req.params.instanceId },
        select: { status: true, accessExpiresAt: true },
      });
      if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

      const access = resolveAccess(tenant);
      return {
        allowed: access.allowed,
        reason: access.reason,
        status: tenant.status,
        accessExpiresAt: tenant.accessExpiresAt?.toISOString() ?? null,
      };
    },
  );

  // Proxy Claude CLI health probe to tenant backend.
  // Returns { ok, path, version, error } — lets super-admin see whether
  // the tenant's `claude` binary is reachable and authenticated, instead
  // of discovering it only through the silent fallback in askClaude().
  app.get<{ Params: { id: string } }>(
    '/api/tenants/:id/claude-health',
    auth,
    async (req, reply) => {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
      if (!tenant) return reply.status(404).send({ error: 'Not found' });

      if (!config.SUPERVISOR_SHARED_SECRET) {
        return reply.status(503).send({
          error: 'SUPERVISOR_SHARED_SECRET is not set in super-admin .env',
        });
      }

      try {
        const res = await fetch(
          `http://localhost:${tenant.apiPort}/supervisor/claude-health`,
          {
            headers: { 'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET },
            signal: AbortSignal.timeout(10_000),
          },
        );

        const data: any = await res.json().catch(() => ({}));

        if (!res.ok) {
          return reply.status(res.status).send({
            error: data?.error || `Tenant returned ${res.status}`,
          });
        }

        return data;
      } catch (err: any) {
        return reply.status(502).send({ error: 'Tenant unreachable', detail: err.message });
      }
    },
  );
}
