import type { FastifyInstance } from 'fastify';
import {
  followSaSelfDeployLog,
  getSaSelfDeployStatus,
  startSaSelfDeploy,
} from '../lib/sa-self-deploy.js';

/**
 * Super Admin self-update from the web UI (deploy-super-admin.sh).
 * Auth: JWT (same as other admin actions).
 */
export async function saSelfDeployRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [app.authenticate] };

  app.get('/api/platform/self-deploy/status', auth, async () => {
    const { running, job } = getSaSelfDeployStatus();
    return { running, job };
  });

  app.post('/api/platform/self-deploy', auth, async (req, reply) => {
    try {
      const result = startSaSelfDeploy();
      if (!result.started) {
        return reply.status(409).send({
          ok: false,
          started: false,
          job: result.job,
          error: result.error ?? 'Already running',
        });
      }
      app.log.info({ jobId: result.job.id }, '[self-deploy] started from UI');
      return { ok: true, started: true, job: result.job };
    } catch (err: any) {
      app.log.error({ err }, 'Failed to start Super Admin self-deploy');
      return reply.status(500).send({
        ok: false,
        started: false,
        error: err?.message ?? 'Failed to start self-deploy',
      });
    }
  });

  app.get<{ Querystring: { jobId?: string; fromEnd?: string } }>(
    '/api/platform/self-deploy/stream',
    auth,
    async (req, reply) => {
      let jobId = '';
      const rawJobId = req.query.jobId;
      if (typeof rawJobId === 'string' && rawJobId.trim()) {
        jobId = rawJobId.trim();
      } else if (Array.isArray(rawJobId) && typeof rawJobId[0] === 'string') {
        jobId = rawJobId[0].trim();
      }

      if (!jobId) {
        const { job } = getSaSelfDeployStatus();
        if (!job?.id) {
          return reply.status(404).send({ error: 'No self-deploy job' });
        }
        jobId = job.id;
      }

      const fromEndRaw = req.query.fromEnd;
      const fromEnd =
        fromEndRaw === '1' ||
        fromEndRaw === 'true' ||
        (Array.isArray(fromEndRaw) && (fromEndRaw[0] === '1' || fromEndRaw[0] === 'true'));

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
          reply.raw.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
          clientOpen = false;
        }
      };

      try {
        await followSaSelfDeployLog(jobId, send, () => clientOpen, sendKeepalive, { fromEnd });
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
}
