import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_GIT_REPO = 'git@github.com:danylo-pavenko/platform-ai-agent-direct.git';
const DEFAULT_FACEBOOK_APP_ID = '26228249720190273';
const DEFAULT_FACEBOOK_APP_SECRET = 'a503e1a11abd8422ca0be546a5be9645';

export type TenantPayload = {
  id: string;
  instanceId: string;
  name: string;
  apiDomain: string;
  adminDomain: string;
  apiPort: number;
  adminPort: number;
  linuxUser: string;
  appDir: string;
  status: string;
  gitRepo?: string | null;
  envExtra?: string | null;
};

export async function resolvePlatformRepoRoot(): Promise<string> {
  const fromEnv = config.PLATFORM_REPO_ROOT?.trim() || process.env.PLATFORM_REPO_ROOT?.trim();
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
      // next
    }
  }
  throw new Error('provision-client.sh not found — set PLATFORM_REPO_ROOT');
}

export function isPlatformDomains(instanceId: string, apiDomain: string, adminDomain: string): boolean {
  const base = process.env.PLATFORM_BASE_DOMAIN || 'direct-ai-agents.com';
  return (
    apiDomain === `api-${instanceId}.${base}` &&
    adminDomain === `agent-${instanceId}.${base}`
  );
}

export function buildProvisionArgs(tenant: TenantPayload): string[] {
  if (isPlatformDomains(tenant.instanceId, tenant.apiDomain, tenant.adminDomain)) {
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
  tenant: Pick<TenantPayload, 'envExtra'>,
  supervisorSecret: string,
  includeEnvExtra: boolean,
  sa: { saPublicUrl?: string; saApiPort?: number },
): Record<string, string> {
  const saInternalUrl = sa.saPublicUrl?.trim()
    ? sa.saPublicUrl.replace(/\/$/, '')
    : `http://127.0.0.1:${sa.saApiPort ?? 4000}`;
  const patch: Record<string, string> = {
    FACEBOOK_APP_ID: DEFAULT_FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET: DEFAULT_FACEBOOK_APP_SECRET,
    SA_INTERNAL_URL: saInternalUrl,
  };
  if (supervisorSecret) patch.SUPERVISOR_SHARED_SECRET = supervisorSecret;
  if (includeEnvExtra) Object.assign(patch, parseEnvExtra(tenant.envExtra));
  return patch;
}

export function buildEnvMergeScript(
  tenant: Pick<TenantPayload, 'appDir' | 'linuxUser'>,
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

export async function listLivePorts(): Promise<number[]> {
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

export function provisionEnv(tenant: Pick<TenantPayload, 'gitRepo'>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLATFORM_REPO: tenant.gitRepo || DEFAULT_GIT_REPO,
    PROVISION_SOURCE_USER: process.env.PROVISION_SOURCE_USER || 'agentsadmin',
  };
}
