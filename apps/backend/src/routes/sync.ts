import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { runSync } from '../sync-worker.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // POST /sync/trigger — run sync in background (async, don't await)
  app.post('/trigger', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const startedAt = new Date().toISOString();

    // Fire and forget — sync runs in background within this process
    runSync()
      .then(() => app.log.info('Sync completed successfully'))
      .catch((err) => app.log.error({ err }, 'Sync failed'));

    return reply.code(202).send({ message: 'Sync triggered', startedAt });
  });

  // GET /sync/status — return last 20 sync runs
  app.get('/status', { onRequest: [app.authenticate] }, async () => {
    const runs = await prisma.keycrmSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    return { runs };
  });
}
