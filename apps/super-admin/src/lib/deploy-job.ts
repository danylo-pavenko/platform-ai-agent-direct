import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Tenant } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { config } from '../config.js';
import {
  buildEnvMergePatch,
  buildEnvMergeScript,
  buildProvisionClientArgs,
  provisionClientEnv,
  resolveMergeEnvScriptPath,
  resolveProvisionScriptPath,
} from './tenant-provision.js';

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

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** True when a line already carries an explicit failure/diagnostic tag. */
function lineHasExplicitTag(line: string): boolean {
  return (
    line.startsWith('[err]') ||
    line.startsWith('[error]') ||
    line.startsWith('[✗') ||
    line.startsWith('ERROR:') ||
    line.startsWith('FATAL')
  );
}

/**
 * Run a command; stream stdout/stderr to log file. Never tied to HTTP.
 * stderr is labeled `[stderr]` (not `[err]`) — git/npm progress often uses stderr.
 * On non-zero exit, a final `[err]` summary line is appended.
 */
function runLogged(
  args: string[],
  logPath: string,
  opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: opts?.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: opts?.env ?? process.env,
    });

    const writeChunk = (kind: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        if (kind === 'out') {
          appendLine(logPath, line);
          continue;
        }
        // Preserve script-authored failure tags; otherwise mark as stderr only.
        if (lineHasExplicitTag(line)) {
          appendLine(logPath, line);
        } else {
          appendLine(logPath, `[stderr] ${line}`);
        }
      }
    };

    if (opts?.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
    child.stdout?.on('data', (c: Buffer) => writeChunk('out', c));
    child.stderr?.on('data', (c: Buffer) => writeChunk('err', c));
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        appendLine(
          logPath,
          `[err] command exited ${exitCode}: ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''}`,
        );
      }
      resolve(exitCode);
    });
    child.on('error', (err) => {
      appendLine(logPath, `[error] ${err.message}`);
      resolve(1);
    });
  });
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
  // Don't keep the event loop alive solely for the sweeper.
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

async function executeDeployPipeline(tenant: Tenant, logPath: string): Promise<number> {
  const linuxUserQ = shellSingleQuote(tenant.linuxUser);
  const appDirQ = shellSingleQuote(tenant.appDir);
  const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;
  const deployScriptQ = shellSingleQuote(deployScript);

  appendLine(logPath, `[deploy started] ${tenant.name} (${tenant.instanceId})`);

  const checkCode = await runLogged(
    ['bash', '-c', `sudo -u ${linuxUserQ} test -f ${deployScriptQ}`],
    logPath,
  );

  if (checkCode !== 0) {
    const dirNonEmptyCode = await runLogged(
      [
        'bash',
        '-c',
        `sudo -u ${linuxUserQ} bash -c '[ -d ${appDirQ} ] && [ -n "$(ls -A ${appDirQ} 2>/dev/null)" ]'`,
      ],
      logPath,
    );
    if (dirNonEmptyCode === 0) {
      appendLine(
        logPath,
        `[error] ${tenant.appDir} already exists and is not empty, but deploy-client.sh was not found.`,
      );
      appendLine(
        logPath,
        '[error] Re-provision aborted to protect existing data. Check App Dir / Linux User / sudo permissions, or clean the directory manually.',
      );
      appendLine(logPath, '[✗ provision aborted]');
      return 1;
    }

    appendLine(
      logPath,
      '[provision] Project not found — running provision-client.sh (user, DB, nginx, TLS, clone)...',
    );

    let provisionScript: string;
    try {
      provisionScript = await resolveProvisionScriptPath();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logPath, `[error] ${message}`);
      appendLine(logPath, '[✗ provision failed]');
      return 1;
    }

    const provisionArgs = buildProvisionClientArgs(tenant);
    appendLine(logPath, `[provision] bash ${provisionScript} ${provisionArgs.join(' ')}`);

    const provisionCode = await runLogged(
      ['sudo', 'bash', provisionScript, ...provisionArgs],
      logPath,
      { env: provisionClientEnv(tenant) },
    );
    if (provisionCode !== 0) {
      appendLine(logPath, '[✗ provision failed — check errors above]');
      return provisionCode;
    }

    const envPatch = buildEnvMergePatch(
      tenant,
      config.SUPERVISOR_SHARED_SECRET,
      true,
      config.SA_API_PORT,
    );
    try {
      const mergeScriptPath = await resolveMergeEnvScriptPath();
      const mergeScript = buildEnvMergeScript(tenant, envPatch, mergeScriptPath);
      if (mergeScript) {
        appendLine(logPath, '[provision] Merging super-admin env overrides into .env...');
        const mergeCode = await runLogged(['sudo', 'bash', '-s'], logPath, { stdin: mergeScript });
        if (mergeCode !== 0) {
          appendLine(logPath, '[✗ env merge failed]');
          return mergeCode;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logPath, `[warn] env merge script not found: ${message}`);
    }

    appendLine(logPath, '[provision] ✓ Server setup complete');
    appendLine(logPath, '[provision] Starting deploy...');
  } else {
    appendLine(
      logPath,
      '[check] Existing installation found — running safe update deploy (re-provision skipped, .env untouched)',
    );

    const envPatch = buildEnvMergePatch(
      tenant,
      config.SUPERVISOR_SHARED_SECRET,
      false,
      config.SA_API_PORT,
    );
    try {
      const mergeScriptPath = await resolveMergeEnvScriptPath();
      const mergeScript = buildEnvMergeScript(tenant, envPatch, mergeScriptPath);
      if (mergeScript) {
        await runLogged(['sudo', 'bash', '-s'], logPath, { stdin: mergeScript });
      }
    } catch {
      // optional on redeploy
    }
  }

  appendLine(logPath, `[deploy] Running ${deployScript}`);
  const deployCode = await runLogged(
    ['bash', '-c', `sudo -u ${linuxUserQ} bash ${deployScriptQ}`],
    logPath,
  );

  if (deployCode === 0) {
    appendLine(logPath, '[✓ deploy finished successfully]');
    if (tenant.status === 'provisioned') {
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
  } else {
    appendLine(logPath, `[✗ deploy failed with exit code ${deployCode}]`);
  }

  return deployCode;
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
        const code = await executeDeployPipeline(tenant, logPath);
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
): Promise<void> {
  const job = await prisma.deployJob.findUnique({ where: { id: jobId } });
  if (!job) {
    send('[error] Deploy job not found');
    return;
  }

  send(`[job] ${job.id} status=${job.status}`);
  send(`[job] log=${job.logPath}`);

  let offset = 0;
  const pollMs = 400;

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
            if (line.length) send(line);
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
      // Final flush
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
              if (line.length) send(line);
            }
          } finally {
            await fh.close();
          }
        }
      } catch {
        // ignore
      }
      const status = fresh?.status ?? 'failed';
      send(
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
