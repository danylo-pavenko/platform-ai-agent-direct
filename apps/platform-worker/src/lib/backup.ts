import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { resolvePlatformRepoRoot, type TenantPayload } from './provision.js';

function runLogged(
  args: string[],
  onLine: (line: string) => void,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const write = (chunk: Buffer) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.trim()) onLine(line);
      }
    };
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
    child.on('close', (code) => resolvePromise(code ?? 1));
    child.on('error', (err) => {
      onLine(`[error] ${err.message}`);
      resolvePromise(1);
    });
  });
}

export async function executeWorkerBackup(
  tenant: TenantPayload,
  s3Env: Record<string, string>,
  source: string,
  onLine: (line: string) => void,
): Promise<number> {
  const root = await resolvePlatformRepoRoot();
  const script = resolve(root, 'infra/scripts/backup-tenant-db.sh');
  onLine(`[backup] ${script} instance=${tenant.instanceId}`);
  return runLogged(['bash', script], onLine, {
    ...process.env,
    ...s3Env,
    INSTANCE_ID: tenant.instanceId,
    APP_DIR: tenant.appDir,
    BACKUP_SOURCE: source,
  });
}

export async function executeWorkerRestore(
  tenant: TenantPayload,
  s3Env: Record<string, string>,
  storageKey: string,
  onLine: (line: string) => void,
): Promise<number> {
  const root = await resolvePlatformRepoRoot();
  const script = resolve(root, 'infra/scripts/restore-tenant-db.sh');
  onLine(`[restore] ${script} key=${storageKey}`);
  return runLogged(['sudo', 'bash', script], onLine, {
    ...process.env,
    ...s3Env,
    INSTANCE_ID: tenant.instanceId,
    APP_DIR: tenant.appDir,
    STORAGE_KEY: storageKey,
    CONFIRM_INSTANCE_ID: tenant.instanceId,
  });
}
