import { spawn } from 'node:child_process';
import type { Server } from '../../generated/prisma/client.js';
import { config } from '../../config.js';
import {
  buildDeprovisionClientArgs,
  buildEnvMergePatch,
  buildEnvMergeScript,
  buildProvisionClientArgs,
  listLiveApiPorts,
  provisionClientEnv,
  resolveDeprovisionScriptPath,
  resolveMergeEnvScriptPath,
  resolveProvisionScriptPath,
} from '../tenant-provision.js';
import type { TenantDeployInput, WorkerClient, WorkerHealthResult } from './types.js';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function lineHasExplicitTag(line: string): boolean {
  return (
    line.startsWith('[err]') ||
    line.startsWith('[error]') ||
    line.startsWith('[✗') ||
    line.startsWith('ERROR:') ||
    line.startsWith('FATAL')
  );
}

function runLogged(
  args: string[],
  onLine: (line: string) => void,
  opts?: { stdin?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<number> {
  return new Promise((resolve) => {
    if (opts?.signal?.aborted) {
      resolve(1);
      return;
    }

    const child = spawn(args[0], args.slice(1), {
      stdio: opts?.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: opts?.env ?? process.env,
    });

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const writeChunk = (kind: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        if (kind === 'out') {
          onLine(line);
          continue;
        }
        if (lineHasExplicitTag(line)) onLine(line);
        else onLine(`[stderr] ${line}`);
      }
    };

    if (opts?.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
    child.stdout?.on('data', (c: Buffer) => writeChunk('out', c));
    child.stderr?.on('data', (c: Buffer) => writeChunk('err', c));
    child.on('close', (code) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        onLine(
          `[err] command exited ${exitCode}: ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''}`,
        );
      }
      resolve(exitCode);
    });
    child.on('error', (err) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      onLine(`[error] ${err.message}`);
      resolve(1);
    });
  });
}

export function createInProcessWorkerClient(server: Server): WorkerClient {
  return {
    server,

    async healthCheck(): Promise<WorkerHealthResult> {
      return { ok: true, service: 'in-process', hostname: 'local' };
    },

    async listListeningPorts(): Promise<number[]> {
      return listLiveApiPorts();
    },

    async isDeployed(tenant): Promise<boolean> {
      const linuxUserQ = shellSingleQuote(tenant.linuxUser);
      const deployScriptQ = shellSingleQuote(`${tenant.appDir}/infra/scripts/deploy-client.sh`);
      const code = await runLogged(
        ['bash', '-c', `sudo -u ${linuxUserQ} test -f ${deployScriptQ}`],
        () => {},
      );
      return code === 0;
    },

    async runDeployPipeline(tenant, onLine, opts): Promise<number> {
      return executeLocalDeployPipeline(tenant, onLine, opts?.signal);
    },

    async runDestroyPipeline(tenant, onLine, opts): Promise<number> {
      return executeLocalDestroyPipeline(tenant, onLine, opts?.signal);
    },
  };
}

export async function executeLocalDeployPipeline(
  tenant: TenantDeployInput,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const linuxUserQ = shellSingleQuote(tenant.linuxUser);
  const appDirQ = shellSingleQuote(tenant.appDir);
  const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;
  const deployScriptQ = shellSingleQuote(deployScript);

  onLine(`[deploy started] ${tenant.name} (${tenant.instanceId})`);

  const checkCode = await runLogged(
    ['bash', '-c', `sudo -u ${linuxUserQ} test -f ${deployScriptQ}`],
    onLine,
    { signal },
  );

  if (checkCode !== 0) {
    const dirNonEmptyCode = await runLogged(
      [
        'bash',
        '-c',
        `sudo -u ${linuxUserQ} bash -c '[ -d ${appDirQ} ] && [ -n "$(ls -A ${appDirQ} 2>/dev/null)" ]'`,
      ],
      onLine,
      { signal },
    );
    if (dirNonEmptyCode === 0) {
      onLine(
        `[error] ${tenant.appDir} already exists and is not empty, but deploy-client.sh was not found.`,
      );
      onLine(
        '[error] Re-provision aborted to protect existing data. Check App Dir / Linux User / sudo permissions, or clean the directory manually.',
      );
      onLine('[✗ provision aborted]');
      return 1;
    }

    onLine(
      '[provision] Project not found — running provision-client.sh (user, DB, nginx, TLS, clone)...',
    );

    let provisionScript: string;
    try {
      provisionScript = await resolveProvisionScriptPath();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLine(`[error] ${message}`);
      onLine('[✗ provision failed]');
      return 1;
    }

    const provisionArgs = buildProvisionClientArgs(tenant);
    onLine(`[provision] bash ${provisionScript} ${provisionArgs.join(' ')}`);

    const provisionCode = await runLogged(
      ['sudo', 'bash', provisionScript, ...provisionArgs],
      onLine,
      { env: provisionClientEnv(tenant), signal },
    );
    if (provisionCode !== 0) {
      onLine('[✗ provision failed — check errors above]');
      return provisionCode;
    }

    const envPatch = buildEnvMergePatch(
      tenant,
      config.SUPERVISOR_SHARED_SECRET,
      true,
      { saPublicUrl: config.SA_PUBLIC_URL, saApiPort: config.SA_API_PORT },
    );
    try {
      const mergeScriptPath = await resolveMergeEnvScriptPath();
      const mergeScript = buildEnvMergeScript(tenant, envPatch, mergeScriptPath);
      if (mergeScript) {
        onLine('[provision] Merging super-admin env overrides into .env...');
        const mergeCode = await runLogged(['sudo', 'bash', '-s'], onLine, {
          stdin: mergeScript,
          signal,
        });
        if (mergeCode !== 0) {
          onLine('[✗ env merge failed]');
          return mergeCode;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLine(`[warn] env merge script not found: ${message}`);
    }

    onLine('[provision] ✓ Server setup complete');
    onLine('[provision] Starting deploy...');
  } else {
    onLine(
      '[check] Existing installation found — running safe update deploy (re-provision skipped, .env untouched)',
    );

    const envPatch = buildEnvMergePatch(
      tenant,
      config.SUPERVISOR_SHARED_SECRET,
      false,
      { saPublicUrl: config.SA_PUBLIC_URL, saApiPort: config.SA_API_PORT },
    );
    try {
      const mergeScriptPath = await resolveMergeEnvScriptPath();
      const mergeScript = buildEnvMergeScript(tenant, envPatch, mergeScriptPath);
      if (mergeScript) {
        await runLogged(['sudo', 'bash', '-s'], onLine, { stdin: mergeScript, signal });
      }
    } catch {
      // optional on redeploy
    }
  }

  onLine(`[deploy] Running ${deployScript}`);
  const deployCode = await runLogged(
    ['bash', '-c', `sudo -u ${linuxUserQ} bash ${deployScriptQ}`],
    onLine,
    { signal },
  );

  if (deployCode === 0) {
    onLine('[✓ deploy finished successfully]');
  } else {
    onLine(`[✗ deploy failed with exit code ${deployCode}]`);
  }

  return deployCode;
}

export async function executeLocalDestroyPipeline(
  tenant: TenantDeployInput,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  onLine(`[destroy started] ${tenant.name} (${tenant.instanceId})`);
  onLine(`[destroy] linuxUser=${tenant.linuxUser} appDir=${tenant.appDir}`);

  let deprovisionScript: string;
  try {
    deprovisionScript = await resolveDeprovisionScriptPath();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLine(`[error] ${message}`);
    onLine('[✗ destroy failed]');
    return 1;
  }

  const args = buildDeprovisionClientArgs(tenant);
  onLine(`[destroy] sudo bash ${deprovisionScript} ${args.join(' ')}`);

  const code = await runLogged(['sudo', 'bash', deprovisionScript, ...args], onLine, { signal });

  if (code === 0) {
    onLine('[✓ host deprovision finished successfully]');
  } else {
    onLine(`[✗ host deprovision failed with exit code ${code}]`);
  }
  return code;
}
