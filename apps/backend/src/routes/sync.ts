import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { runSync, SyncInProgressError } from '../sync-worker.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // POST /sync/trigger — run sync in background (async, don't await)
  //
  // Concurrency is owned by runSync(): it creates a 'running' row up-front,
  // so a racing click or cron tick will see that and throw SyncInProgressError.
  // We peek at the same state here to give the admin a useful 409 instead of
  // swallowing the second trigger silently.
  app.post('/trigger', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const inFlight = await prisma.keycrmSyncRun.findFirst({
      where: { status: 'running', finishedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (inFlight) {
      return reply.code(409).send({
        error: 'Sync already in progress',
        runId: inFlight.id,
        startedAt: inFlight.startedAt.toISOString(),
      });
    }

    const startedAt = new Date().toISOString();

    // Fire and forget. If another trigger races past our check above,
    // SyncInProgressError is downgraded to a log line — not an unhandled
    // rejection — because the winning run is doing the real work.
    runSync()
      .then(() => app.log.info('Sync completed successfully'))
      .catch((err) => {
        if (err instanceof SyncInProgressError) {
          app.log.warn({ runId: err.runId }, 'Skipped — concurrent run in progress');
          return;
        }
        app.log.error({ err }, 'Sync failed');
      });

    return reply.code(202).send({ message: 'Sync triggered', startedAt });
  });

  // GET /sync/status — return last 20 sync runs (newest first)
  app.get('/status', { onRequest: [app.authenticate] }, async () => {
    const runs = await prisma.keycrmSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    return { runs };
  });
}
