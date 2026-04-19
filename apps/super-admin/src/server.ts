import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { tenantsRoutes } from './routes/tenants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
});

// ── Plugins ──
await app.register(fastifyCors, { origin: true });

await app.register(fastifyJwt, { secret: config.JWT_SECRET });

// Auth decorator
app.decorate('authenticate', async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
});

// Serve Vue SPA from public/
await app.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
  decorateReply: false,
});

// ── Routes ──
await app.register(authRoutes);
await app.register(tenantsRoutes);

// Health check
app.get('/api/health', async () => ({ status: 'ok', service: 'super-admin' }));

// SPA fallback — all non-API routes → index.html
app.setNotFoundHandler(async (req, reply) => {
  if (!req.url.startsWith('/api')) {
    return reply.sendFile('index.html');
  }
  reply.status(404).send({ error: 'Not found' });
});

// ── Start ──
try {
  await app.listen({ port: config.SA_API_PORT, host: '127.0.0.1' });
  app.log.info(`Super Admin API running on port ${config.SA_API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
