import type { Server } from '../../generated/prisma/client.js';
import { config } from '../../config.js';
import type { TenantDeployInput, WorkerClient, WorkerHealthResult } from './types.js';

type RemoteJobStart = { jobId: string };

function authHeaders(secret: string | null | undefined): Record<string, string> {
  if (!secret) return {};
  return { Authorization: `Bearer ${secret}` };
}

async function readSseLines(
  res: Response,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) throw new Error('Empty SSE body from worker');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        for (const raw of part.split('\n')) {
          if (raw.startsWith('data: ')) onLine(raw.slice(6));
        }
      }
    }
    if (buf.startsWith('data: ')) onLine(buf.slice(6));
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export function createHttpWorkerClient(server: Server): WorkerClient {
  if (!server.baseUrl) {
    throw new Error(`Remote worker "${server.name}" has no baseUrl`);
  }
  if (!server.sharedSecret) {
    throw new Error(`Remote worker "${server.name}" has no sharedSecret`);
  }

  const base = server.baseUrl.replace(/\/$/, '');
  const secret = server.sharedSecret;

  return {
    server,

    async healthCheck(): Promise<WorkerHealthResult> {
      try {
        const r = await fetch(`${base}/health`, {
          headers: authHeaders(secret),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
        const d = (await r.json()) as { service?: string; hostname?: string };
        return { ok: true, service: d.service, hostname: d.hostname };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async listListeningPorts(): Promise<number[]> {
      const r = await fetch(`${base}/v1/ports`, {
        headers: authHeaders(secret),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`worker /v1/ports HTTP ${r.status}`);
      const d = (await r.json()) as { ports?: number[] };
      return Array.isArray(d.ports) ? d.ports : [];
    },

    async isDeployed(tenant): Promise<boolean> {
      const r = await fetch(
        `${base}/v1/tenants/${encodeURIComponent(tenant.linuxUser)}/deployed?appDir=${encodeURIComponent(tenant.appDir)}`,
        { headers: authHeaders(secret), signal: AbortSignal.timeout(15_000) },
      );
      if (!r.ok) return false;
      const d = (await r.json()) as { deployed?: boolean };
      return !!d.deployed;
    },

    async runDeployPipeline(tenant, onLine, opts): Promise<number> {
      const body = {
        tenant: {
          id: tenant.id,
          instanceId: tenant.instanceId,
          name: tenant.name,
          apiDomain: tenant.apiDomain,
          adminDomain: tenant.adminDomain,
          apiPort: tenant.apiPort,
          adminPort: tenant.adminPort,
          linuxUser: tenant.linuxUser,
          appDir: tenant.appDir,
          status: tenant.status,
          gitRepo: tenant.gitRepo,
          envExtra: tenant.envExtra,
        },
        supervisorSecret: config.SUPERVISOR_SHARED_SECRET,
        saPublicUrl: config.SA_PUBLIC_URL || undefined,
        saApiPort: config.SA_API_PORT,
      };

      const startRes = await fetch(`${base}/v1/jobs/pipeline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(secret),
        },
        body: JSON.stringify(body),
        signal: opts?.signal,
      });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({})) as { error?: string };
        onLine(`[error] worker pipeline start: ${err.error || `HTTP ${startRes.status}`}`);
        return 1;
      }
      const started = (await startRes.json()) as RemoteJobStart;
      onLine(`[worker] remote job ${started.jobId}`);

      const streamRes = await fetch(`${base}/v1/jobs/${started.jobId}/stream`, {
        headers: authHeaders(secret),
        signal: opts?.signal,
      });
      if (!streamRes.ok) {
        onLine(`[error] worker stream HTTP ${streamRes.status}`);
        return 1;
      }

      let exitCode = 1;
      await readSseLines(streamRes, (line) => {
        onLine(line);
        if (line.startsWith('[job] finished: succeeded')) exitCode = 0;
        const m = line.match(/\[job\] finished:.*\(exit (\d+)\)/);
        if (m) exitCode = Number(m[1]);
        if (line.startsWith('[✓ deploy finished successfully]')) exitCode = 0;
      }, opts?.signal);

      // Prefer explicit status endpoint if available
      try {
        const st = await fetch(`${base}/v1/jobs/${started.jobId}`, {
          headers: authHeaders(secret),
          signal: AbortSignal.timeout(10_000),
        });
        if (st.ok) {
          const j = (await st.json()) as { status?: string; exitCode?: number | null };
          if (typeof j.exitCode === 'number') exitCode = j.exitCode;
          else if (j.status === 'succeeded') exitCode = 0;
          else if (j.status === 'failed') exitCode = exitCode === 0 ? 1 : exitCode;
        }
      } catch {
        // keep inferred exitCode
      }

      return exitCode;
    },

    async runDestroyPipeline(tenant, onLine, opts): Promise<number> {
      const body = {
        tenant: {
          id: tenant.id,
          instanceId: tenant.instanceId,
          name: tenant.name,
          apiDomain: tenant.apiDomain,
          adminDomain: tenant.adminDomain,
          apiPort: tenant.apiPort,
          adminPort: tenant.adminPort,
          linuxUser: tenant.linuxUser,
          appDir: tenant.appDir,
          status: tenant.status,
          gitRepo: tenant.gitRepo,
          envExtra: tenant.envExtra,
        },
        supervisorSecret: config.SUPERVISOR_SHARED_SECRET,
        saPublicUrl: config.SA_PUBLIC_URL || undefined,
        saApiPort: config.SA_API_PORT,
      };

      const startRes = await fetch(`${base}/v1/jobs/destroy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(secret),
        },
        body: JSON.stringify(body),
        signal: opts?.signal,
      });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({})) as { error?: string };
        onLine(`[error] worker destroy start: ${err.error || `HTTP ${startRes.status}`}`);
        return 1;
      }
      const started = (await startRes.json()) as RemoteJobStart;
      onLine(`[worker] remote destroy job ${started.jobId}`);

      const streamRes = await fetch(`${base}/v1/jobs/${started.jobId}/stream`, {
        headers: authHeaders(secret),
        signal: opts?.signal,
      });
      if (!streamRes.ok) {
        onLine(`[error] worker stream HTTP ${streamRes.status}`);
        return 1;
      }

      let exitCode = 1;
      await readSseLines(streamRes, (line) => {
        onLine(line);
        if (line.startsWith('[job] finished: succeeded')) exitCode = 0;
        const m = line.match(/\[job\] finished:.*\(exit (\d+)\)/);
        if (m) exitCode = Number(m[1]);
        if (line.startsWith('[✓ host deprovision finished successfully]')) exitCode = 0;
      }, opts?.signal);

      try {
        const st = await fetch(`${base}/v1/jobs/${started.jobId}`, {
          headers: authHeaders(secret),
          signal: AbortSignal.timeout(10_000),
        });
        if (st.ok) {
          const j = (await st.json()) as { status?: string; exitCode?: number | null };
          if (typeof j.exitCode === 'number') exitCode = j.exitCode;
          else if (j.status === 'succeeded') exitCode = 0;
          else if (j.status === 'failed') exitCode = exitCode === 0 ? 1 : exitCode;
        }
      } catch {
        // keep inferred
      }

      return exitCode;
    },
  };
}
