import { hostname } from 'node:os';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { followJobLog, getJob, startDestroyJob, startPipelineJob } from './lib/jobs.js';
import { listLivePorts, type TenantPayload } from './lib/provision.js';
import { spawn } from 'node:child_process';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
});

function requireWorkerAuth(req: { headers: Record<string, unknown> }, reply: {
  status: (code: number) => { send: (body: unknown) => unknown };
}): boolean {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== config.WORKER_SHARED_SECRET) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

const pipelineBody = z.object({
  tenant: z.object({
    id: z.string(),
    instanceId: z.string(),
    name: z.string(),
    apiDomain: z.string(),
    adminDomain: z.string(),
    apiPort: z.number(),
    adminPort: z.number(),
    linuxUser: z.string(),
    appDir: z.string(),
    status: z.string(),
    gitRepo: z.string().nullable().optional(),
    envExtra: z.string().nullable().optional(),
  }),
  supervisorSecret: z.string().default(''),
  saPublicUrl: z.string().optional(),
  saApiPort: z.number().optional(),
});

app.get('/health', async () => ({
  status: 'ok',
  service: 'platform-worker',
  hostname: config.WORKER_NAME || hostname(),
}));

app.get('/v1/ports', async (req, reply) => {
  if (!requireWorkerAuth(req as any, reply as any)) return;
  const ports = await listLivePorts();
  return { ports };
});

app.get<{ Params: { linuxUser: string }; Querystring: { appDir?: string } }>(
  '/v1/tenants/:linuxUser/deployed',
  async (req, reply) => {
    if (!requireWorkerAuth(req as any, reply as any)) return;
    const linuxUser = req.params.linuxUser;
    const appDir = req.query.appDir || `/home/${linuxUser}/platform-ai-agent-direct`;
    const deployScript = `${appDir}/infra/scripts/deploy-client.sh`;

    const code = await new Promise<number>((resolve) => {
      const qUser = `'${linuxUser.replace(/'/g, `'\\''`)}'`;
      const qScript = `'${deployScript.replace(/'/g, `'\\''`)}'`;
      const child = spawn('bash', ['-c', `sudo -u ${qUser} test -f ${qScript}`]);
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });

    return { deployed: code === 0, appDir };
  },
);

app.post('/v1/jobs/pipeline', async (req, reply) => {
  if (!requireWorkerAuth(req as any, reply as any)) return;
  const body = pipelineBody.safeParse(req.body);
  if (!body.success) {
    return reply.status(400).send({ error: body.error.message });
  }

  const tenant = body.data.tenant as TenantPayload;
  const job = startPipelineJob(tenant, {
    supervisorSecret: body.data.supervisorSecret,
    saPublicUrl: body.data.saPublicUrl,
    saApiPort: body.data.saApiPort,
  });
  return { jobId: job.id };
});

app.post('/v1/jobs/destroy', async (req, reply) => {
  if (!requireWorkerAuth(req as any, reply as any)) return;
  const body = pipelineBody.safeParse(req.body);
  if (!body.success) {
    return reply.status(400).send({ error: body.error.message });
  }

  const tenant = body.data.tenant as TenantPayload;
  const job = startDestroyJob(tenant);
  return { jobId: job.id };
});

app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
  if (!requireWorkerAuth(req as any, reply as any)) return;
  const job = getJob(req.params.id);
  if (!job) return reply.status(404).send({ error: 'Not found' });
  return job;
});

app.get<{ Params: { id: string } }>('/v1/jobs/:id/stream', async (req, reply) => {
  if (!requireWorkerAuth(req as any, reply as any)) return;
  const job = getJob(req.params.id);
  if (!job) return reply.status(404).send({ error: 'Not found' });

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let open = true;
  req.raw.on('close', () => { open = false; });

  const send = (line: string) => {
    if (!open) return;
    reply.raw.write(`data: ${line}\n\n`);
  };
  const keepalive = () => {
    if (!open) return;
    reply.raw.write(': keepalive\n\n');
  };

  try {
    await followJobLog(req.params.id, send, () => open, keepalive);
  } finally {
    try { reply.raw.end(); } catch { /* ignore */ }
  }
});

try {
  await app.listen({ port: config.WORKER_PORT, host: config.WORKER_HOST });
  app.log.info(`platform-worker on ${config.WORKER_HOST}:${config.WORKER_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
