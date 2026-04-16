import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { authPlugin } from './lib/auth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { authRoutes } from './routes/admin-auth.js';
import { syncRoutes } from './routes/sync.js';
import { conversationRoutes } from './routes/conversations.js';
import { promptRoutes } from './routes/prompts.js';
import { settingsRoutes } from './routes/settings.js';
import { orderRoutes } from './routes/orders.js';
import { metaAgentRoutes } from './routes/meta-agent.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// Plugins
await app.register(cors, {
  origin: [
    `https://${config.ADMIN_DOMAIN}`,
    `http://${config.ADMIN_DOMAIN}`,
    // Allow localhost for development
    /^http:\/\/localhost(:\d+)?$/,
  ],
  credentials: true,
});

await app.register(jwt, {
  secret: config.JWT_SECRET,
  sign: { expiresIn: config.JWT_EXPIRES_IN },
});

// Auth decorator
await app.register(authPlugin);

// Routes
await app.register(webhookRoutes);
await app.register(authRoutes, { prefix: '/auth' });
await app.register(syncRoutes, { prefix: '/sync' });
await app.register(conversationRoutes, { prefix: '/conversations' });
await app.register(promptRoutes, { prefix: '/prompts' });
await app.register(settingsRoutes, { prefix: '/settings' });
await app.register(orderRoutes, { prefix: '/orders' });
await app.register(metaAgentRoutes, { prefix: '/meta-agent' });

// Health check
app.get('/health', async () => {
  await prisma.$queryRawUnsafe('SELECT 1');
  return {
    status: 'ok',
    instance: config.INSTANCE_ID,
    timestamp: new Date().toISOString(),
  };
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
try {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  app.log.info(
    `${config.INSTANCE_NAME} API running on port ${config.API_PORT}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app };
