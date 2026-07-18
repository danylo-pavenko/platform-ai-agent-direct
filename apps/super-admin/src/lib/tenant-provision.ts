import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tenant } from '../generated/prisma/client.js';
import {
  DEFAULT_FACEBOOK_APP_ID,
  DEFAULT_FACEBOOK_APP_SECRET,
  DEFAULT_TENANT_GIT_REPO,
} from './constants.js';
import { isPlatformTenantDomains } from './tenant-domains.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve monorepo root (contains infra/scripts/provision-client.sh). */
export async function resolvePlatformRepoRoot(): Promise<string> {
  const fromEnv = process.env.PLATFORM_REPO_ROOT?.trim();
  const candidates = [
    fromEnv,
    resolve(process.cwd(), '../..'),
    resolve(process.cwd(), '../../..'),
    resolve(__dirname, '../../../..'),
  ].filter(Boolean) as string[];

  for (const root of candidates) {
    try {
      await access(resolve(root, 'infra/scripts/provision-client.sh'));
      return root;
    } catch {
      // try next
    }
  }

  throw new Error(
    'provision-client.sh not found. Set PLATFORM_REPO_ROOT to the platform-ai-agent-direct repo root.',
  );
}

export async function resolveMergeEnvScriptPath(): Promise<string> {
  const root = await resolvePlatformRepoRoot();
  return resolve(root, 'infra/scripts/merge-tenant-env.mjs');
}

export async function resolveProvisionScriptPath(): Promise<string> {
  const root = await resolvePlatformRepoRoot();
  return resolve(root, 'infra/scripts/provision-client.sh');
}

export function buildProvisionClientArgs(tenant: Pick<
  Tenant,
  'instanceId' | 'name' | 'apiDomain' | 'adminDomain' | 'apiPort' | 'adminPort'
>): string[] {
  if (isPlatformTenantDomains(tenant.instanceId, tenant.apiDomain, tenant.adminDomain)) {
    return [
      tenant.instanceId,
      tenant.name,
      '--platform',
      String(tenant.apiPort),
      String(tenant.adminPort),
    ];
  }

  return [
    tenant.instanceId,
    tenant.name,
    tenant.apiDomain,
    tenant.adminDomain,
    String(tenant.apiPort),
    String(tenant.adminPort),
  ];
}

/** Parse KEY=VALUE lines from super-admin envExtra textarea. */
export function parseEnvExtra(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw?.trim()) return out;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && value !== '') out[key] = value;
  }
  return out;
}

export function buildEnvMergePatch(
  tenant: Pick<Tenant, 'envExtra'>,
  supervisorSecret: string,
  includeEnvExtra: boolean,
  saApiPort = 4000,
): Record<string, string> {
  const patch: Record<string, string> = {
    FACEBOOK_APP_ID: DEFAULT_FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET: DEFAULT_FACEBOOK_APP_SECRET,
    SA_INTERNAL_URL: `http://127.0.0.1:${saApiPort}`,
  };
  if (supervisorSecret) patch.SUPERVISOR_SHARED_SECRET = supervisorSecret;
  if (includeEnvExtra) Object.assign(patch, parseEnvExtra(tenant.envExtra));
  return patch;
}

/** Bash script: upsert JSON patch keys into tenant .env (run as root). */
export function buildEnvMergeScript(
  tenant: Pick<Tenant, 'appDir' | 'linuxUser'>,
  patch: Record<string, string>,
  mergeScriptPath: string,
): string {
  if (Object.keys(patch).length === 0) return '';

  const patchB64 = Buffer.from(JSON.stringify(patch)).toString('base64');
  const appDir = tenant.appDir.replace(/'/g, `'\\''`);
  const linuxUser = tenant.linuxUser.replace(/'/g, `'\\''`);
  const mergeScript = mergeScriptPath.replace(/'/g, `'\\''`);

  return `
set -euo pipefail
ENV_FILE='${appDir}/.env'
if [ ! -f "$ENV_FILE" ]; then
  echo "[env] .env not found at $ENV_FILE — skip merge"
  exit 0
fi
node '${mergeScript}' "$ENV_FILE" '${patchB64}'
chown '${linuxUser}:${linuxUser}' "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "[env] merged keys: ${Object.keys(patch).join(', ')}"
`.trim();
}

export async function listLiveApiPorts(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnH'], { timeout: 5000 });
    const ports: number[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/:(\d+)\s/);
      if (m) ports.push(Number(m[1]));
    }
    return ports;
  } catch {
    return [];
  }
}

export function provisionClientEnv(tenant: Pick<Tenant, 'gitRepo'>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLATFORM_REPO: tenant.gitRepo || DEFAULT_TENANT_GIT_REPO,
    PROVISION_SOURCE_USER: process.env.PROVISION_SOURCE_USER || 'agentsadmin',
  };
}
