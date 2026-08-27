import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { executeWorkerDestroyPipeline, executeWorkerPipeline } from './pipeline.js';
import type { TenantPayload } from './provision.js';

const LOG_DIR = process.env.WORKER_JOB_LOG_DIR || '/tmp/platform-worker-jobs';

export type WorkerJob = {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  logPath: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

const jobs = new Map<string, WorkerJob>();

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
}

function appendLine(logPath: string, line: string): void {
  appendFileSync(logPath, `${line}\n`);
}

export function getJob(id: string): WorkerJob | undefined {
  return jobs.get(id);
}

export function startPipelineJob(
  tenant: TenantPayload,
  opts: { supervisorSecret: string; saPublicUrl?: string; saApiPort?: number },
): WorkerJob {
  ensureLogDir();
  const id = randomUUID();
  const logPath = join(LOG_DIR, `${tenant.instanceId}-${id}.log`);
  appendFileSync(logPath, '');

  const job: WorkerJob = {
    id,
    status: 'running',
    logPath,
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  jobs.set(id, job);

  void (async () => {
    try {
      const code = await executeWorkerPipeline(tenant, opts, (line) => appendLine(logPath, line));
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      appendLine(
        logPath,
        code === 0
          ? '[job] finished: succeeded'
          : `[job] finished: failed (exit ${code})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logPath, `[error] ${message}`);
      appendLine(logPath, '[job] finished: failed (exit 1)');
      job.status = 'failed';
      job.exitCode = 1;
      job.error = message;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

export function startDestroyJob(tenant: TenantPayload): WorkerJob {
  ensureLogDir();
  const id = randomUUID();
  const logPath = join(LOG_DIR, `destroy-${tenant.instanceId}-${id}.log`);
  appendFileSync(logPath, '');

  const job: WorkerJob = {
    id,
    status: 'running',
    logPath,
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  jobs.set(id, job);

  void (async () => {
    try {
      const code = await executeWorkerDestroyPipeline(tenant, (line) => appendLine(logPath, line));
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      appendLine(
        logPath,
        code === 0
          ? '[job] finished: succeeded'
          : `[job] finished: failed (exit ${code})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logPath, `[error] ${message}`);
      appendLine(logPath, '[job] finished: failed (exit 1)');
      job.status = 'failed';
      job.exitCode = 1;
      job.error = message;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

export async function followJobLog(
  jobId: string,
  send: (line: string) => void,
  isConnected: () => boolean,
  sendKeepalive?: () => void,
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    send('[error] Job not found');
    return;
  }

  send(`[job] ${job.id} status=${job.status}`);
  send(`[job] log=${job.logPath}`);

  let offset = 0;
  const pollMs = 400;
  const keepaliveMs = 10_000;
  let lastByteAt = Date.now();

  const emit = (line: string) => {
    send(line);
    lastByteAt = Date.now();
  };

  while (isConnected()) {
    try {
      const st = await stat(job.logPath);
      if (st.size > offset) {
        const fh = await open(job.logPath, 'r');
        try {
          const length = st.size - offset;
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, offset);
          offset = st.size;
          for (const line of buf.toString('utf8').split('\n')) {
            if (line.length) emit(line);
          }
        } finally {
          await fh.close();
        }
      }
    } catch {
      // not yet
    }

    const fresh = jobs.get(jobId);
    if (!fresh || fresh.status !== 'running') {
      try {
        const st = await stat(job.logPath);
        if (st.size > offset) {
          const text = readFileSync(job.logPath, 'utf8').slice(offset);
          for (const line of text.split('\n')) {
            if (line.length) emit(line);
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    if (Date.now() - lastByteAt >= keepaliveMs) {
      try { sendKeepalive?.(); } catch { /* ignore */ }
      emit('[stream] keepalive');
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
