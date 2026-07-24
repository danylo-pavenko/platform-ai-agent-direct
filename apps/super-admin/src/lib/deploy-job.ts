import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from './prisma.js';
import { getServerForTenant } from './servers.js';
import { getWorkerClient } from './worker/client.js';

const log = {
  warn: (obj: unknown, msg?: string) => console.warn('[deploy-job]', msg ?? '', obj),
  error: (obj: unknown, msg?: string) => console.error('[deploy-job]', msg ?? '', obj),
};

const LOG_DIR = process.env.SA_DEPLOY_LOG_DIR || '/tmp/platform-sa-deploys';
/** Safety net for abandoned running jobs (npm timeout should fail sooner). */
const STALE_JOB_MS = 90 * 60 * 1000; // 90 minutes
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** In-process set of tenant IDs currently deploying (fast double-click guard). */
const runningTenantIds = new Set<string>();

export type DeployJobPublic = {
  id: string;
  tenantId: string;
  status: 'running' | 'succeeded' | 'failed';
  logPath: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
}

function appendLine(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch (err) {
    log.warn({ err, logPath }, 'Failed to append deploy log line');
  }
}

export function toDeployJobPublic(job: {
  id: string;
  tenantId: string;
  status: string;
  logPath: string;
  exitCode: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}): DeployJobPublic {
  return {
    id: job.id,
    tenantId: job.tenantId,
    status: job.status as DeployJobPublic['status'],
    logPath: job.logPath,
    exitCode: job.exitCode,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error,
  };
}

export async function getActiveDeployJob(tenantId: string): Promise<DeployJobPublic | null> {
  const job = await prisma.deployJob.findFirst({
    where: { tenantId, status: 'running' },
    orderBy: { startedAt: 'desc' },
  });
  return job ? toDeployJobPublic(job) : null;
}

export async function getLatestDeployJob(tenantId: string): Promise<DeployJobPublic | null> {
  const job = await prisma.deployJob.findFirst({
    where: { tenantId },
    orderBy: { startedAt: 'desc' },
  });
  return job ? toDeployJobPublic(job) : null;
}

export async function getDeployJob(jobId: string): Promise<DeployJobPublic | null> {
  const job = await prisma.deployJob.findUnique({ where: { id: jobId } });
  return job ? toDeployJobPublic(job) : null;
}

/** Mark orphaned running jobs as failed (SA restart mid-deploy or hung pipeline). */
export async function markStaleDeployJobsFailed(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_JOB_MS);
  const result = await prisma.deployJob.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: cutoff },
    },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      error: `Marked stale after ${Math.round(STALE_JOB_MS / 60_000)}m without finish`,
      exitCode: 1,
    },
  });
  if (result.count > 0) {
    log.warn({ count: result.count }, 'Marked stale deploy jobs as failed');
  }
  return result.count;
}

let staleSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Periodic reclaim of stuck `running` jobs (also call once on SA boot). */
export function startStaleDeployJobSweeper(logger?: {
  info: (obj: unknown, msg?: string) => void;
}): void {
  if (staleSweepTimer) return;
  const run = () => {
    void markStaleDeployJobsFailed().catch((err) => {
      log.warn({ err }, 'Stale deploy job sweep failed');
    });
  };
  run();
  staleSweepTimer = setInterval(run, STALE_SWEEP_INTERVAL_MS);
  if (typeof staleSweepTimer === 'object' && 'unref' in staleSweepTimer) {
    staleSweepTimer.unref();
  }
  logger?.info(
    { intervalMs: STALE_SWEEP_INTERVAL_MS, staleAfterMs: STALE_JOB_MS },
    'Deploy job stale sweeper started',
  );
}

export function stopStaleDeployJobSweeper(): void {
  if (staleSweepTimer) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
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

/**
 * Start a background deploy job for the tenant.
 * Returns existing running job if one is already in progress (idempotent attach).
 */
export async function startDeployJob(tenantId: string): Promise<{
  job: DeployJobPublic;
  started: boolean;
  error?: string;
}> {
  const existing = await getActiveDeployJob(tenantId);
  if (existing || runningTenantIds.has(tenantId)) {
    const job = existing ?? (await getActiveDeployJob(tenantId));
    if (job) return { job, started: false };
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  if (runningTenantIds.has(tenantId)) {
    const job = await getActiveDeployJob(tenantId);
    if (job) return { job, started: false };
  }

  runningTenantIds.add(tenantId);
  ensureLogDir();

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(LOG_DIR, `${tenant.instanceId}-${stamp}.log`);
    appendFileSync(logPath, '');

    const created = await prisma.deployJob.create({
      data: {
        tenantId,
        status: 'running',
        logPath,
      },
    });

    const jobPublic = toDeployJobPublic(created);

    void (async () => {
      try {
        const server = await getServerForTenant(tenant.serverId);
        const client = getWorkerClient(server);
        appendLine(logPath, `[worker] ${server.name} (${server.kind})`);

        const code = await client.runDeployPipeline(tenant, (line) => appendLine(logPath, line));

        if (code === 0 && tenant.status === 'provisioned') {
          try {
            await prisma.tenant.update({
              where: { id: tenant.id },
              data: { status: 'active' },
            });
            appendLine(logPath, '[status] Registry updated: provisioned → active');
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            appendLine(logPath, `[warn] Deploy OK but failed to set status=active: ${message}`);
          }
        }

        await finishJob(created.id, code === 0 ? 'succeeded' : 'failed', code);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLine(logPath, `[error] ${message}`);
        appendLine(logPath, '[✗ deploy failed]');
        await finishJob(created.id, 'failed', 1, message);
        log.error({ err, tenantId, jobId: created.id }, 'Deploy job crashed');
      } finally {
        runningTenantIds.delete(tenantId);
      }
    })();

    return { job: jobPublic, started: true };
  } catch (err) {
    runningTenantIds.delete(tenantId);
    throw err;
  }
}

/**
 * Tail a deploy log file over SSE-style callbacks until the job finishes.
 * Safe to disconnect — does not kill the job.
 */
export async function followDeployLog(
  jobId: string,
  send: (line: string) => void,
  isClientConnected: () => boolean,
  sendKeepalive?: () => void,
  opts?: { fromEnd?: boolean },
): Promise<void> {
  const job = await prisma.deployJob.findUnique({ where: { id: jobId } });
  if (!job) {
    send('[error] Deploy job not found');
    return;
  }

  send(`[job] ${job.id} status=${job.status}`);
  send(`[job] log=${job.logPath}`);

  let offset = 0;
  if (opts?.fromEnd) {
    try {
      offset = (await stat(job.logPath)).size;
      send('[stream] resumed from live tail');
    } catch {
      offset = 0;
    }
  }

  const pollMs = 400;
  const keepaliveMs = 10_000;
  let lastByteAt = Date.now();

  const emit = (line: string) => {
    send(line);
    lastByteAt = Date.now();
  };

  const pump = async (): Promise<'running' | 'done'> => {
    try {
      const st = await stat(job.logPath);
      if (st.size > offset) {
        const fh = await open(job.logPath, 'r');
        try {
          const length = st.size - offset;
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, offset);
          offset = st.size;
          const text = buf.toString('utf8');
          for (const line of text.split('\n')) {
            if (line.length) emit(line);
          }
        } finally {
          await fh.close();
        }
      }
    } catch {
      // log file may not exist yet
    }

    const fresh = await prisma.deployJob.findUnique({ where: { id: jobId } });
    if (!fresh || fresh.status !== 'running') {
      try {
        const st = await stat(job.logPath);
        if (st.size > offset) {
          const fh = await open(job.logPath, 'r');
          try {
            const length = st.size - offset;
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);
            const text = buf.toString('utf8');
            for (const line of text.split('\n')) {
              if (line.length) emit(line);
            }
          } finally {
            await fh.close();
          }
        }
      } catch {
        // ignore
      }
      const status = fresh?.status ?? 'failed';
      emit(
        status === 'succeeded'
          ? '[job] finished: succeeded'
          : `[job] finished: ${status}${fresh?.exitCode != null ? ` (exit ${fresh.exitCode})` : ''}`,
      );
      return 'done';
    }
    return 'running';
  };

  while (isClientConnected()) {
    const state = await pump();
    if (state === 'done') return;

    if (Date.now() - lastByteAt >= keepaliveMs) {
      try {
        sendKeepalive?.();
      } catch {
        // ignore
      }
      emit('[stream] keepalive');
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Read full log contents (for late attach / download). */
export function readDeployLogSync(logPath: string): string {
  if (!existsSync(logPath)) return '';
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}
