import { config as saConfig } from '../config.js';

/** Slug / instance_id — aligned with infra/scripts/lib/tenant-domains.sh */
export const INSTANCE_ID_RE = /^[a-z0-9-]{2,24}$/;

export function platformBaseDomain(): string {
  return saConfig.PLATFORM_BASE_DOMAIN;
}

export function platformApiDomain(slug: string): string {
  return `api-${slug}.${platformBaseDomain()}`;
}

export function platformAdminDomain(slug: string): string {
  return `agent-${slug}.${platformBaseDomain()}`;
}

export function isPlatformTenantDomains(
  slug: string,
  apiDomain: string,
  adminDomain: string,
): boolean {
  return (
    apiDomain === platformApiDomain(slug) && adminDomain === platformAdminDomain(slug)
  );
}

export function defaultLinuxUser(slug: string): string {
  return slug;
}

export function defaultAppDir(slug: string): string {
  return `/home/${slug}/platform-ai-agent-direct`;
}

/** Next free API/admin port pair (+100 step), using registry + optional live ports. */
export function suggestNextPortPair(
  usedApiPorts: number[],
  liveApiPorts: number[] = [],
): { apiPort: number; adminPort: number } {
  const used = new Set([...usedApiPorts, ...liveApiPorts]);
  const base = saConfig.PLATFORM_PORT_BASE;
  const step = saConfig.PLATFORM_PORT_STEP;
  const max = saConfig.PLATFORM_PORT_MAX;

  for (let port = base; port <= max; port += step) {
    const adminPort = port + 1;
    if (!used.has(port) && !used.has(adminPort)) {
      return { apiPort: port, adminPort };
    }
  }

  throw new Error(
    `No free port pair in range ${base}–${max} (step ${step}). Free a tenant port or raise PLATFORM_PORT_MAX.`,
  );
}

export function platformDefaultsForSlug(slug: string): {
  apiDomain: string;
  adminDomain: string;
  linuxUser: string;
  appDir: string;
} {
  return {
    apiDomain: platformApiDomain(slug),
    adminDomain: platformAdminDomain(slug),
    linuxUser: defaultLinuxUser(slug),
    appDir: defaultAppDir(slug),
  };
}
