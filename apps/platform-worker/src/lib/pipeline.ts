import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  buildDeprovisionArgs,
  buildEnvMergePatch,
  buildEnvMergeScript,
  buildProvisionArgs,
  provisionEnv,
  resolveDeprovisionScriptPath,
  resolvePlatformRepoRoot,
  type TenantPayload,
} from './provision.js';

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
  opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: opts?.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: opts?.env ?? process.env,
    });

    const writeChunk = (kind: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        if (kind === 'out') onLine(line);
        else if (lineHasExplicitTag(line)) onLine(line);
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
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        onLine(
          `[err] command exited ${exitCode}: ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''}`,
        );
      }
      resolvePromise(exitCode);
    });
    child.on('error', (err) => {
      onLine(`[error] ${err.message}`);
      resolvePromise(1);
    });
  });
}

export async function executeWorkerPipeline(
  tenant: TenantPayload,
  opts: {
    supervisorSecret: string;
    saPublicUrl?: string;
    saApiPort?: number;
  },
  onLine: (line: string) => void,
): Promise<number> {
  const linuxUserQ = shellSingleQuote(tenant.linuxUser);
  const appDirQ = shellSingleQuote(tenant.appDir);
  const deployScript = `${tenant.appDir}/infra/scripts/deploy-client.sh`;
  const deployScriptQ = shellSingleQuote(deployScript);

  onLine(`[deploy started] ${tenant.name} (${tenant.instanceId})`);

  const checkCode = await runLogged(
    ['bash', '-c', `sudo -u ${linuxUserQ} test -f ${deployScriptQ}`],
    onLine,
  );

  if (checkCode !== 0) {
    const dirNonEmptyCode = await runLogged(
      [
        'bash',
        '-c',
        `sudo -u ${linuxUserQ} bash -c '[ -d ${appDirQ} ] && [ -n "$(ls -A ${appDirQ} 2>/dev/null)" ]'`,
      ],
      onLine,
    );
    if (dirNonEmptyCode === 0) {
      onLine(
        `[error] ${tenant.appDir} already exists and is not empty, but deploy-client.sh was not found.`,
      );
      onLine('[✗ provision aborted]');
      return 1;
    }

    onLine('[provision] Project not found — running provision-client.sh...');
    const root = await resolvePlatformRepoRoot();
    const provisionScript = resolve(root, 'infra/scripts/provision-client.sh');
    const provisionArgs = buildProvisionArgs(tenant);
    onLine(`[provision] bash ${provisionScript} ${provisionArgs.join(' ')}`);

    const provisionCode = await runLogged(
      ['sudo', 'bash', provisionScript, ...provisionArgs],
      onLine,
      { env: provisionEnv(tenant) },
    );
    if (provisionCode !== 0) {
      onLine('[✗ provision failed — check errors above]');
      return provisionCode;
    }

    const envPatch = buildEnvMergePatch(tenant, opts.supervisorSecret, true, {
      saPublicUrl: opts.saPublicUrl,
      saApiPort: opts.saApiPort,
    });
    const mergeScriptPath = resolve(root, 'infra/scripts/merge-tenant-env.mjs');
    const mergeScript = buildEnvMergeScript(tenant, envPatch, mergeScriptPath);
    if (mergeScript) {
      onLine('[provision] Merging env overrides into .env...');
      const mergeCode = await runLogged(['sudo', 'bash', '-s'], onLine, { stdin: mergeScript });
      if (mergeCode !== 0) {
        onLine('[✗ env merge failed]');
        return mergeCode;
      }
    }

    onLine('[provision] ✓ Server setup complete');
    onLine('[provision] Starting deploy...');
  } else {
    onLine('[check] Existing installation — safe update deploy');
    try {
      const root = await resolvePlatformRepoRoot();
      const envPatch = buildEnvMergePatch(tenant, opts.supervisorSecret, false, {
        saPublicUrl: opts.saPublicUrl,
        saApiPort: opts.saApiPort,
      });
      const mergeScriptPath = resolve(root, 'infra/scripts/merge-tenant-env.mjs');
      const mergeScript = buildEnvMergeScript(tenant, envPatch, mergeScriptPath);
      if (mergeScript) {
        await runLogged(['sudo', 'bash', '-s'], onLine, { stdin: mergeScript });
      }
    } catch {
      // optional
    }
  }

  onLine(`[deploy] Running ${deployScript}`);
  const deployCode = await runLogged(
    ['bash', '-c', `sudo -u ${linuxUserQ} bash ${deployScriptQ}`],
    onLine,
  );

  if (deployCode === 0) onLine('[✓ deploy finished successfully]');
  else onLine(`[✗ deploy failed with exit code ${deployCode}]`);

  return deployCode;
}

export async function executeWorkerDestroyPipeline(
  tenant: TenantPayload,
  onLine: (line: string) => void,
): Promise<number> {
  onLine(`[destroy started] ${tenant.name} (${tenant.instanceId})`);
  onLine(`[destroy] linuxUser=${tenant.linuxUser}`);

  let deprovisionScript: string;
  try {
    deprovisionScript = await resolveDeprovisionScriptPath();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLine(`[error] ${message}`);
    onLine('[✗ destroy failed]');
    return 1;
  }

  const args = buildDeprovisionArgs(tenant);
  onLine(`[destroy] sudo bash ${deprovisionScript} ${args.join(' ')}`);
  const code = await runLogged(['sudo', 'bash', deprovisionScript, ...args], onLine);
  if (code === 0) onLine('[✓ host deprovision finished successfully]');
  else onLine(`[✗ host deprovision failed with exit code ${code}]`);
  return code;
}
