/**
 * Background backup / restore jobs (same lock + log pattern as deploy/destroy).
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from './prisma.js';
import { getServerForTenant } from './servers.js';
import { getWorkerClient } from './worker/client.js';
import {
  followDeployLog,
  getActiveTenantJob,
  getDeployJob,
  isTenantJobLocked,
  releaseTenantJobLock,
  toDeployJobPublic,
  tryAcquireTenantJobLock,
  type DeployJobPublic,
} from './deploy-job.js';
import {
  parseBackupScriptMarkers,
  resolveWorkerS3Config,
  s3ConfigToEnv,
  type WorkerS3Config,
} from './s3-backup.js';

const log = {
  warn: (obj: unknown, msg?: string) => console.warn('[backup-job]', msg ?? '', obj),
  error: (obj: unknown, msg?: string) => console.error('[backup-job]', msg ?? '', obj),
};

const LOG_DIR = process.env.SA_DEPLOY_LOG_DIR || '/tmp/platform-sa-deploys';

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
}

function appendLine(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch (err) {
    log.warn({ err, logPath }, 'Failed to append backup log line');
  }
}

async function finishJob(
  jobId: string,
  status: 'succeeded' | 'failed',
  exitCode: number,
  error?: string,
): Promise<void> {
  await prisma.deployJob.update({
    where: { id: jobId },
    data: {
      status,
      exitCode,
      finishedAt: new Date(),
      error: error ?? null,
    },
  });
}

export type BackupSource = 'manual' | 'scheduled' | 'pre_deploy' | 'pre_restore';

async function requireS3ForTenant(tenantId: string): Promise<{
  tenant: NonNullable<Awaited<ReturnType<typeof prisma.tenant.findUnique>>>;
  server: Awaited<ReturnType<typeof getServerForTenant>>;
  s3: WorkerS3Config;
}> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found');
  const server = await getServerForTenant(tenant.serverId);
  const s3 = resolveWorkerS3Config(server);
  if (!s3) {
    throw new Error(
      `Worker «${server.name}» has no S3 backup storage configured (enable + endpoint/bucket/keys)`,
    );
  }
  return { tenant, server, s3 };
}

async function recordBackupRow(opts: {
  tenantId: string;
  serverId: string | null;
  storageKey: string;
  sha256?: string;
  bytes?: number;
  source: BackupSource;
  status: 'uploaded' | 'failed';
}): Promise<void> {
  await prisma.tenantBackup.create({
    data: {
      tenantId: opts.tenantId,
      serverId: opts.serverId,
      storageKey: opts.storageKey,
      sha256: opts.sha256 ?? null,
      bytes: opts.bytes != null ? BigInt(opts.bytes) : null,
      source: opts.source,
      status: opts.status,
    },
  });
}

/**
 * Run a backup without creating a DeployJob row (used inside deploy pre-step).
 * Returns 0 on success. Appends to the provided log path.
 */
export async function runPreDeployBackupInline(
  tenantId: string,
  logPath: string,
): Promise<number> {
  try {
    const { tenant, server, s3 } = await requireS3ForTenant(tenantId);
    const client = getWorkerClient(server);
    const deployed = await client.isDeployed(tenant);
    if (!deployed) {
      appendLine(logPath, '[backup] skip pre-deploy (tenant not deployed yet — first provision)');
      return 0;
    }
    appendLine(logPath, '[backup] pre-deploy dump starting…');
    const lines: string[] = [];
    const code = await client.runBackupPipeline(
      tenant,
      s3ConfigToEnv(s3),
      'pre_deploy',
      (line) => {
        appendLine(logPath, line);
        lines.push(line);
      },
    );
    const markers = parseBackupScriptMarkers(lines.join('\n'));
    if (code === 0 && markers.storageKey) {
      await recordBackupRow({
        tenantId: tenant.id,
        serverId: server.id,
        storageKey: markers.storageKey,
        sha256: markers.sha256,
        bytes: markers.bytes,
        source: 'pre_deploy',
        status: 'uploaded',
      });
      appendLine(logPath, `[backup] pre-deploy ✓ ${markers.storageKey}`);
      return 0;
    }
    appendLine(logPath, '[backup] pre-deploy FAILED — aborting deploy');
    if (markers.storageKey) {
      await recordBackupRow({
        tenantId: tenant.id,
        serverId: server.id,
        storageKey: markers.storageKey,
        sha256: markers.sha256,
        bytes: markers.bytes,
        source: 'pre_deploy',
        status: 'failed',
      });
    }
    return code === 0 ? 1 : code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No S3 configured → skip (do not fail deploy)
    if (/no S3 backup storage configured/i.test(message)) {
      appendLine(logPath, `[backup] skip pre-deploy (${message})`);
      return 0;
    }
    appendLine(logPath, `[backup] pre-deploy error: ${message}`);
    return 1;
  }
}

export async function startBackupJob(
  tenantId: string,
  source: BackupSource = 'manual',
): Promise<{ job: DeployJobPublic; started: boolean; error?: string }> {
  const existingAny = await getActiveTenantJob(tenantId);
  if (existingAny || isTenantJobLocked(tenantId)) {
    return {
      job: existingAny ?? {
        id: 'unknown',
        tenantId,
        kind: 'backup',
        status: 'running',
        logPath: '',
        exitCode: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
      },
      started: false,
      error: existingAny
        ? `A ${existingAny.kind} job is already running for this tenant`
        : 'Tenant job lock held',
    };
  }

  const { tenant, server, s3 } = await requireS3ForTenant(tenantId);

  if (!tryAcquireTenantJobLock(tenantId)) {
    const other = await getActiveTenantJob(tenantId);
    return {
      job: other!,
      started: false,
      error: other ? `A ${other.kind} job is already running` : 'Lock busy',
    };
  }

  ensureLogDir();
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(LOG_DIR, `backup-${tenant.instanceId}-${stamp}.log`);
    appendFileSync(logPath, '');
    const created = await prisma.deployJob.create({
      data: {
        tenantId,
        kind: 'backup',
        status: 'running',
        logPath,
      },
    });
    appendLine(logPath, `[backup] source=${source} worker=${server.name}`);
    const jobPublic = toDeployJobPublic(created);

    void (async () => {
      const lines: string[] = [];
      try {
        const client = getWorkerClient(server);
        const code = await client.runBackupPipeline(
          tenant,
          s3ConfigToEnv(s3),
          source,
          (line) => {
            appendLine(logPath, line);
            lines.push(line);
          },
        );
        const markers = parseBackupScriptMarkers(lines.join('\n'));
        if (code === 0 && markers.storageKey) {
          await recordBackupRow({
            tenantId: tenant.id,
            serverId: server.id,
            storageKey: markers.storageKey,
            sha256: markers.sha256,
            bytes: markers.bytes,
            source,
            status: 'uploaded',
          });
        } else if (markers.storageKey) {
          await recordBackupRow({
            tenantId: tenant.id,
            serverId: server.id,
            storageKey: markers.storageKey,
            sha256: markers.sha256,
            bytes: markers.bytes,
            source,
            status: 'failed',
          });
        }
        await finishJob(created.id, code === 0 ? 'succeeded' : 'failed', code);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLine(logPath, `[error] ${message}`);
        await finishJob(created.id, 'failed', 1, message);
        log.error({ err, tenantId, jobId: created.id }, 'Backup job crashed');
      } finally {
        releaseTenantJobLock(tenantId);
      }
    })();

    return { job: jobPublic, started: true };
  } catch (err) {
    releaseTenantJobLock(tenantId);
    throw err;
  }
}

export async function startRestoreJob(
  tenantId: string,
  storageKey: string,
  confirmInstanceId: string,
): Promise<{ job: DeployJobPublic; started: boolean; error?: string }> {
  const existingAny = await getActiveTenantJob(tenantId);
  if (existingAny || isTenantJobLocked(tenantId)) {
    return {
      job: existingAny!,
      started: false,
      error: existingAny
        ? `A ${existingAny.kind} job is already running for this tenant`
        : 'Tenant job lock held',
    };
  }

  const { tenant, server, s3 } = await requireS3ForTenant(tenantId);
  if (confirmInstanceId !== tenant.instanceId) {
    throw new Error(`Confirm instanceId must be «${tenant.instanceId}»`);
  }
  if (!storageKey.startsWith(`tenants/${tenant.instanceId}/`)) {
    throw new Error('storageKey does not belong to this tenant');
  }

  if (!tryAcquireTenantJobLock(tenantId)) {
    const other = await getActiveTenantJob(tenantId);
    return {
      job: other!,
      started: false,
      error: other ? `A ${other.kind} job is already running` : 'Lock busy',
    };
  }

  ensureLogDir();
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(LOG_DIR, `restore-${tenant.instanceId}-${stamp}.log`);
    appendFileSync(logPath, '');
    const created = await prisma.deployJob.create({
      data: {
        tenantId,
        kind: 'restore',
        status: 'running',
        logPath,
      },
    });
    appendLine(logPath, `[restore] key=${storageKey} worker=${server.name}`);
    const jobPublic = toDeployJobPublic(created);

    void (async () => {
      try {
        const client = getWorkerClient(server);
        const code = await client.runRestorePipeline(
          tenant,
          s3ConfigToEnv(s3),
          storageKey,
          (line) => appendLine(logPath, line),
        );
        await finishJob(created.id, code === 0 ? 'succeeded' : 'failed', code);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLine(logPath, `[error] ${message}`);
        await finishJob(created.id, 'failed', 1, message);
        log.error({ err, tenantId, jobId: created.id }, 'Restore job crashed');
      } finally {
        releaseTenantJobLock(tenantId);
      }
    })();

    return { job: jobPublic, started: true };
  } catch (err) {
    releaseTenantJobLock(tenantId);
    throw err;
  }
}

export { followDeployLog, getDeployJob, toDeployJobPublic };
