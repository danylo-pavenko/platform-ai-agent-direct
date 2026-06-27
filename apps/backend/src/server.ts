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
import { metaAgentTeachRoutes } from './routes/meta-agent-teach.js';
import { metaOAuthRoutes } from './routes/meta-oauth.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { supervisorRoutes } from './routes/supervisor.js';
import { crmFieldsRoutes } from './routes/crm-fields.js';
import { analyticsRoutes } from './routes/analytics.js';
import { mediaRoutes } from './routes/media.js';

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
await app.register(metaAgentTeachRoutes, { prefix: '/meta-agent/teach' });
await app.register(metaOAuthRoutes, { prefix: '/settings' });
await app.register(sandboxRoutes, { prefix: '/sandbox' });
await app.register(dashboardRoutes, { prefix: '/dashboard' });
await app.register(supervisorRoutes, { prefix: '/supervisor' });
await app.register(crmFieldsRoutes, { prefix: '/crm-fields' });
await app.register(analyticsRoutes, { prefix: '/analytics' });
await app.register(mediaRoutes, { prefix: '/media' });

// Health check
app.get('/health', async () => {
  await prisma.$queryRawUnsafe('SELECT 1');
  const { pingWhisperService } = await import('./services/transcribe.js');
  const sttOk = config.STT_ENABLED ? await pingWhisperService() : null;
  return {
    status: 'ok',
    instance: config.INSTANCE_ID,
    timestamp: new Date().toISOString(),
    stt: config.STT_ENABLED
      ? { enabled: true, whisperReachable: sttOk }
      : { enabled: false },
  };
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`);
  const { stopConversationRetryMonitor } = await import('./services/conversation-retry.js');
  const { stopClaudeAuthMonitor } = await import('./services/claude-auth-monitor.js');
  stopConversationRetryMonitor();
  stopClaudeAuthMonitor();
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

  const { startClaudeUsageMonitor } = await import('./services/claude-usage-monitor.js');
  startClaudeUsageMonitor(app.log);

  const { startClaudeAuthMonitor } = await import('./services/claude-auth-monitor.js');
  startClaudeAuthMonitor(app.log);

  const { startConversationRetryMonitor } = await import('./services/conversation-retry.js');
  startConversationRetryMonitor(app.log);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app };
