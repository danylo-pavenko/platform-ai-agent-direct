import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { prisma } from '../lib/prisma.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // POST /sync/trigger — spawn sync-worker as detached child process
  app.post('/trigger', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const isDev = process.env.NODE_ENV !== 'production';
    const startedAt = new Date().toISOString();

    if (isDev) {
      const child = spawn('npx', ['tsx', 'src/sync-worker.ts'], {
        cwd: 'apps/backend',
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      app.log.info({ pid: child.pid }, 'Sync worker spawned (dev mode)');
    } else {
      const child = spawn('node', ['--enable-source-maps', 'dist/sync-worker.js'], {
        cwd: 'apps/backend',
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      app.log.info({ pid: child.pid }, 'Sync worker spawned (production)');
    }

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
