import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  followDeployLog,
  getDeployJob,
  startBackupJob,
  startRestoreJob,
} from '../lib/backup-job.js';
import { encryptSecret } from '../lib/secret-box.js';
import {
  publicS3FromServer,
  resolveWorkerS3Config,
  testWorkerS3,
} from '../lib/s3-backup.js';

const patchStorageSchema = z.object({
  s3Enabled: z.boolean().optional(),
  s3Endpoint: z.string().url().nullable().optional(),
  s3Bucket: z.string().min(1).max(128).nullable().optional(),
  s3Region: z.string().min(1).max(64).optional(),
  s3ForcePathStyle: z.boolean().optional(),
  s3AccessKey: z.string().min(1).max(256).nullable().optional(),
  /** Write-only; omit or empty to keep existing. */
  s3SecretAccessKey: z.string().min(1).max(512).optional(),
});

const restoreSchema = z.object({
  storageKey: z.string().min(8),
  confirmInstanceId: z.string().min(1),
});

export async function backupsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [app.authenticate] };

  app.get<{ Params: { id: string } }>(
    '/api/workers/:id/backup-storage',
    auth,
    async (req, reply) => {
      const row = await prisma.server.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.status(404).send({ error: 'Not found' });
      return publicS3FromServer(row);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/workers/:id/backup-storage',
    auth,
    async (req, reply) => {
      const body = patchStorageSchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({
          error: body.error.issues.map((i) => i.message).join('; '),
        });
      }
      const existing = await prisma.server.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      const data: Record<string, unknown> = {};
      const b = body.data;
      if (b.s3Enabled !== undefined) data.s3Enabled = b.s3Enabled;
      if (b.s3Endpoint !== undefined) {
        data.s3Endpoint = b.s3Endpoint ? b.s3Endpoint.replace(/\/$/, '') : null;
      }
      if (b.s3Bucket !== undefined) data.s3Bucket = b.s3Bucket;
      if (b.s3Region !== undefined) data.s3Region = b.s3Region;
      if (b.s3ForcePathStyle !== undefined) data.s3ForcePathStyle = b.s3ForcePathStyle;
      if (b.s3AccessKey !== undefined) data.s3AccessKey = b.s3AccessKey;
      if (b.s3SecretAccessKey?.trim()) {
        data.s3SecretEnc = encryptSecret(b.s3SecretAccessKey.trim());
      }

      const updated = await prisma.server.update({
        where: { id: req.params.id },
        data,
      });
      return publicS3FromServer(updated);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/workers/:id/backup-storage/test',
    auth,
    async (req, reply) => {
      const row = await prisma.server.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.status(404).send({ error: 'Not found' });
      const cfg = resolveWorkerS3Config(row);
      if (!cfg) {
        return reply.status(400).send({
          ok: false,
          error: 'S3 not fully configured (enable + endpoint + bucket + keys)',
        });
      }
      const result = await testWorkerS3(cfg);
      await prisma.server.update({
        where: { id: row.id },
        data: {
          s3LastTestAt: new Date(),
          s3LastTestOk: result.ok,
        },
      });
      if (!result.ok) {
        return reply.status(502).send({ ok: false, error: result.error });
      }
      return { ok: true };
    },
  );

  app.get('/api/backups', auth, async (req) => {
    const q = req.query as { tenantId?: string; serverId?: string; limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '100', 10) || 100, 1), 500);
    const rows = await prisma.tenantBackup.findMany({
      where: {
        ...(q.tenantId ? { tenantId: q.tenantId } : {}),
        ...(q.serverId ? { serverId: q.serverId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        tenant: { select: { id: true, instanceId: true, name: true } },
        server: { select: { id: true, name: true } },
      },
    });
    return {
      backups: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        serverId: r.serverId,
        storageKey: r.storageKey,
        bytes: r.bytes != null ? Number(r.bytes) : null,
        sha256: r.sha256,
        source: r.source,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        tenant: r.tenant,
        server: r.server,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/tenants/:id/backup', auth, async (req, reply) => {
    try {
      const result = await startBackupJob(req.params.id, 'manual');
      if (result.error && !result.started) {
        return reply.status(409).send({ started: false, job: result.job, error: result.error });
      }
      return { started: result.started, job: result.job };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'Backup failed to start' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/tenants/:id/restore', auth, async (req, reply) => {
    const body = restoreSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'storageKey and confirmInstanceId required' });
    }
    try {
      const result = await startRestoreJob(
        req.params.id,
        body.data.storageKey,
        body.data.confirmInstanceId,
      );
      if (result.error && !result.started) {
        return reply.status(409).send({ started: false, job: result.job, error: result.error });
      }
      return { started: result.started, job: result.job };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'Restore failed to start' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/backups/jobs/:id', auth, async (req, reply) => {
    const job = await getDeployJob(req.params.id);
    if (!job) return reply.status(404).send({ error: 'Not found' });
    return { job };
  });

  app.get<{ Params: { id: string }; Querystring: { fromEnd?: string } }>(
    '/api/backups/jobs/:id/stream',
    auth,
    async (req, reply) => {
      const job = await getDeployJob(req.params.id);
      if (!job) return reply.status(404).send({ error: 'Not found' });
      if (job.kind !== 'backup' && job.kind !== 'restore') {
        return reply.status(400).send({ error: 'Not a backup/restore job' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let open = true;
      req.raw.on('close', () => {
        open = false;
      });
      const send = (line: string) => {
        if (!open) return;
        reply.raw.write(`data: ${line}\n\n`);
      };
      const keepalive = () => {
        if (!open) return;
        reply.raw.write(': keepalive\n\n');
      };

      try {
        await followDeployLog(
          job.id,
          send,
          () => open,
          keepalive,
          { fromEnd: req.query.fromEnd === '1' },
        );
      } finally {
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      }
    },
  );
}
