/**
 * Super Admin self-deploy: run deploy-super-admin.sh as a detached job
 * so PM2 restart of SA-api does not kill the update.
 *
 * State is file-based under /tmp/platform-sa-self-deploy (survives API restart).
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const log = {
  warn: (obj: unknown, msg?: string) => console.warn('[sa-self-deploy]', msg ?? '', obj),
  error: (obj: unknown, msg?: string) => console.error('[sa-self-deploy]', msg ?? '', obj),
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SaSelfDeployJob = {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  logPath: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
};

function deployDir(): string {
  return process.env.SA_SELF_DEPLOY_DIR || '/tmp/platform-sa-self-deploy';
}

function jobJsonPath(): string {
  return resolve(deployDir(), 'job.json');
}

function logPath(): string {
  return resolve(deployDir(), 'current.log');
}

function lockPath(): string {
  return resolve(deployDir(), 'deploy.lock');
}

/** Exclusive mkdir gate so two POSTs cannot overwrite job.json before flock. */
function startGatePath(): string {
  return resolve(deployDir(), 'starting.lockdir');
}

/** Repo root: apps/super-admin/src/lib → ../../../../ */
export function resolveRepoRoot(): string {
  return resolve(__dirname, '..', '..', '..', '..');
}

export function resolveDeploySuperAdminScript(): string {
  // Tests set SA_SELF_DEPLOY_SCRIPT_OVERRIDE to a fake script (never real PM2).
  const override = process.env.SA_SELF_DEPLOY_SCRIPT_OVERRIDE?.trim();
  if (override) return override;
  return resolve(resolveRepoRoot(), 'infra/scripts/deploy-super-admin.sh');
}

export function resolveSelfDeployWrapperScript(): string {
  const override = process.env.SA_SELF_DEPLOY_WRAPPER_OVERRIDE?.trim();
  if (override) return override;
  return resolve(resolveRepoRoot(), 'infra/scripts/run-sa-self-deploy-job.sh');
}

function ensureDir(): void {
  const dir = deployDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0x1ed });
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we cannot signal it (common in sandboxes).
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return true;
    return false;
  }
}

function lockHeld(): boolean {
  // Linux flock file is not a reliable "held" signal without flock(2);
  // mkdir lock dir is the portable indicator used by the wrapper fallback.
  return existsSync(resolve(deployDir(), 'flock.lockdir')) || existsSync(startGatePath());
}

function parseJob(raw: unknown): SaSelfDeployJob | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  const status = o.status === 'succeeded' || o.status === 'failed' || o.status === 'running'
    ? o.status
    : null;
  if (!id || !status) return null;
  const pid = typeof o.pid === 'number' ? o.pid : o.pid == null ? null : Number(o.pid);
  return {
    id,
    status,
    logPath: typeof o.logPath === 'string' ? o.logPath : logPath(),
    pid: Number.isFinite(pid as number) ? (pid as number) : null,
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : new Date().toISOString(),
    finishedAt: typeof o.finishedAt === 'string' ? o.finishedAt : null,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : o.exitCode == null ? null : Number(o.exitCode),
    error: typeof o.error === 'string' ? o.error : null,
  };
}

function readJobFile(): SaSelfDeployJob | null {
  try {
    const raw = JSON.parse(readFileSync(jobJsonPath(), 'utf8')) as unknown;
    return parseJob(raw);
  } catch {
    return null;
  }
}

function writeJobFile(job: SaSelfDeployJob): void {
  ensureDir();
  writeFileSync(jobJsonPath(), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

/** If job.json says running but pid is dead, mark failed (stale). */
export function reconcileStaleSaSelfDeploy(): SaSelfDeployJob | null {
  const job = readJobFile();
  if (!job) return null;
  if (job.status === 'running' && !isPidAlive(job.pid)) {
    const stale: SaSelfDeployJob = {
      ...job,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: job.exitCode ?? 1,
      error: job.error ?? 'self-deploy process exited without writing final status',
    };
    try {
      writeJobFile(stale);
      appendFileSync(logPath(), `\n[self-deploy] marked stale (pid ${job.pid} not alive)\n`);
      rmSync(startGatePath(), { recursive: true, force: true });
    } catch (err) {
      log.warn({ err }, 'Failed to mark stale self-deploy');
    }
    return stale;
  }
  return job;
}

export function getSaSelfDeployStatus(): {
  running: boolean;
  job: SaSelfDeployJob | null;
} {
  const job = reconcileStaleSaSelfDeploy();
  return {
    running: Boolean(job && job.status === 'running' && isPidAlive(job.pid)),
    job,
  };
}

export function startSaSelfDeploy(): {
  started: boolean;
  job: SaSelfDeployJob;
  error?: string;
} {
  ensureDir();
  const current = reconcileStaleSaSelfDeploy();
  const busyJob = (): SaSelfDeployJob =>
    current ?? {
      id: 'unknown',
      status: 'running',
      logPath: logPath(),
      pid: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: 'self-deploy already in progress',
    };

  // Never overwrite job.json while a deploy holds the gate/lock — a rejected
  // second start must not clobber the running job's metadata.
  if (
    (current?.status === 'running' && isPidAlive(current.pid)) ||
    existsSync(resolve(deployDir(), 'flock.lockdir')) ||
    existsSync(startGatePath())
  ) {
    // Clear only a truly stale gate (no lock dir, pid gone).
    if (
      existsSync(startGatePath()) &&
      !existsSync(resolve(deployDir(), 'flock.lockdir')) &&
      !(current?.status === 'running' && isPidAlive(current.pid))
    ) {
      try {
        rmSync(startGatePath(), { recursive: true, force: true });
      } catch {
        // ignore
      }
    } else {
      return {
        started: false,
        job: busyJob(),
        error: 'Super Admin self-deploy already running',
      };
    }
  }

  const script = resolveDeploySuperAdminScript();
  const wrapper = resolveSelfDeployWrapperScript();
  if (!existsSync(script)) {
    throw new Error(`deploy-super-admin.sh not found: ${script}`);
  }
  if (!existsSync(wrapper)) {
    throw new Error(`run-sa-self-deploy-job.sh not found: ${wrapper}`);
  }

  // Atomic start gate (cleared by wrapper on finish / stale reconcile).
  try {
    mkdirSync(startGatePath());
  } catch {
    return {
      started: false,
      job: reconcileStaleSaSelfDeploy() ?? busyJob(),
      error: 'Super Admin self-deploy already starting',
    };
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const logFile = logPath();

  writeFileSync(logFile, '', 'utf8');
  appendFileSync(
    logFile,
    `[self-deploy] requested by Super Admin UI at ${startedAt}\n`,
  );

  const job: SaSelfDeployJob = {
    id: jobId,
    status: 'running',
    logPath: logFile,
    pid: null,
    startedAt,
    finishedAt: null,
    exitCode: null,
    error: null,
  };
  writeJobFile(job);

  try {
    const fd = openSync(lockPath(), 'a');
    closeSync(fd);
  } catch {
    // ignore
  }

  const child = spawn('bash', [wrapper], {
    detached: true,
    stdio: 'ignore',
    cwd: resolveRepoRoot(),
    env: {
      ...process.env,
      SA_SELF_DEPLOY_DIR: deployDir(),
      SA_SELF_DEPLOY_JOB_ID: jobId,
      SA_SELF_DEPLOY_SCRIPT: script,
    },
  });
  child.unref();

  if (child.pid) {
    job.pid = child.pid;
    writeJobFile(job);
  }

  return { started: true, job };
}

/**
 * Tail self-deploy log until the job finishes. Safe to disconnect — does not kill the job.
 */
export async function followSaSelfDeployLog(
  jobId: string,
  send: (line: string) => void,
  isClientConnected: () => boolean,
  sendKeepalive?: () => void,
  opts?: { fromEnd?: boolean },
): Promise<void> {
  let job = reconcileStaleSaSelfDeploy();
  if (!job || job.id !== jobId) {
    // Allow following while wrapper still rewriting job.json
    job = readJobFile();
  }
  if (!job || job.id !== jobId) {
    send('[error] Self-deploy job not found');
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
    const logFile = job!.logPath;
    try {
      const st = await stat(logFile);
      if (st.size > offset) {
        const fh = await open(logFile, 'r');
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
      // log may not exist yet
    }

    const fresh = reconcileStaleSaSelfDeploy();
    if (!fresh || fresh.id !== jobId) {
      emit('[job] finished: failed (job missing)');
      return 'done';
    }
    if (fresh.status !== 'running') {
      // flush remaining log
      try {
        const st = await stat(fresh.logPath);
        if (st.size > offset) {
          const fh = await open(fresh.logPath, 'r');
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
        // ignore
      }
      emit(
        fresh.status === 'succeeded'
          ? '[job] finished: succeeded'
          : `[job] finished: ${fresh.status}${fresh.exitCode != null ? ` (exit ${fresh.exitCode})` : ''}`,
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
      lastByteAt = Date.now();
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
