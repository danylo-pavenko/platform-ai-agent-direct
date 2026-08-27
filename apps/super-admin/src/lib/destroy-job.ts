import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from './prisma.js';
import { getServerForTenant } from './servers.js';
import { getWorkerClient } from './worker/client.js';
import {
  assertDestroyableLinuxUser,
} from './tenant-provision.js';
import {
  followDeployLog,
  getActiveDeployJob,
  getActiveTenantJob,
  getDeployJob,
  getLatestDeployJob,
  isTenantJobLocked,
  releaseTenantJobLock,
  toDeployJobPublic,
  tryAcquireTenantJobLock,
  type DeployJobPublic,
} from './deploy-job.js';

const log = {
  warn: (obj: unknown, msg?: string) => console.warn('[destroy-job]', msg ?? '', obj),
  error: (obj: unknown, msg?: string) => console.error('[destroy-job]', msg ?? '', obj),
};

const LOG_DIR = process.env.SA_DEPLOY_LOG_DIR || '/tmp/platform-sa-deploys';

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
}

function appendLine(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch (err) {
    log.warn({ err, logPath }, 'Failed to append destroy log line');
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

export async function getActiveDestroyJob(tenantId: string): Promise<DeployJobPublic | null> {
  return getActiveDeployJob(tenantId, 'destroy');
}

export async function getLatestDestroyJob(tenantId: string): Promise<DeployJobPublic | null> {
  return getLatestDeployJob(tenantId, 'destroy');
}

export { getDeployJob, followDeployLog };

/**
 * Start a background destroy job (host deprovision + registry delete on success).
 * Attaches to an already-running destroy job; errors if a deploy is running.
 */
export async function startDestroyJob(tenantId: string): Promise<{
  job: DeployJobPublic;
  started: boolean;
  error?: string;
}> {
  const existingAny = await getActiveTenantJob(tenantId);
  if (existingAny || isTenantJobLocked(tenantId)) {
    if (existingAny?.kind === 'destroy') {
      return { job: existingAny, started: false };
    }
    if (existingAny?.kind === 'deploy') {
      return {
        job: existingAny,
        started: false,
        error: 'A deploy job is already running for this tenant — wait or open Deploy log',
      };
    }
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  try {
    assertDestroyableLinuxUser(tenant.linuxUser);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }

  if (!tryAcquireTenantJobLock(tenantId)) {
    const job = await getActiveDestroyJob(tenantId);
    if (job) return { job, started: false };
    const other = await getActiveTenantJob(tenantId);
    if (other) {
      return {
        job: other,
        started: false,
        error: `A ${other.kind} job is already running for this tenant`,
      };
    }
  }

  ensureLogDir();

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(LOG_DIR, `destroy-${tenant.instanceId}-${stamp}.log`);
    appendFileSync(logPath, '');

    const created = await prisma.deployJob.create({
      data: {
        tenantId,
        kind: 'destroy',
        status: 'running',
        logPath,
      },
    });

    const jobPublic = toDeployJobPublic(created);
    const tenantSnapshot = { ...tenant };

    void (async () => {
      try {
        const server = await getServerForTenant(tenantSnapshot.serverId);
        const client = getWorkerClient(server);
        appendLine(logPath, `[destroy] ${tenantSnapshot.name} (${tenantSnapshot.instanceId})`);
        appendLine(logPath, `[worker] ${server.name} (${server.kind})`);
        appendLine(
          logPath,
          `[destroy] Will remove Linux user ${tenantSnapshot.linuxUser}, DB, nginx, PM2, then registry row`,
        );

        const code = await client.runDestroyPipeline(tenantSnapshot, (line) =>
          appendLine(logPath, line),
        );

        if (code !== 0) {
          appendLine(logPath, `[✗ destroy failed with exit code ${code}]`);
          appendLine(logPath, '[destroy] Registry row kept — fix leftovers or retry Destroy');
          await finishJob(created.id, 'failed', code);
          return;
        }

        appendLine(logPath, '[destroy] Host deprovision OK — deleting SA registry row…');
        try {
          // Mark succeeded before delete so a brief race still shows success;
          // cascade then removes the job row with the tenant.
          await finishJob(created.id, 'succeeded', 0);
          await prisma.tenant.delete({ where: { id: tenantSnapshot.id } });
          appendLine(logPath, '[status] Registry row deleted (webhook routing cleared)');
          appendLine(logPath, '[✓ destroy finished successfully]');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendLine(logPath, `[error] Host OK but registry delete failed: ${message}`);
          appendLine(
            logPath,
            '[destroy] Use soft Delete in SA to remove the registry row, or retry',
          );
          try {
            await finishJob(created.id, 'failed', 1, message);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLine(logPath, `[error] ${message}`);
        appendLine(logPath, '[✗ destroy failed]');
        try {
          await finishJob(created.id, 'failed', 1, message);
        } catch {
          // tenant may already be gone
        }
        log.error({ err, tenantId, jobId: created.id }, 'Destroy job crashed');
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
