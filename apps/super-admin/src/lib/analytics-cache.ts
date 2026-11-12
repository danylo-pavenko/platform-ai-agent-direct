/**
 * Persist / read Super Admin fleet analytics (tenant supervisor snapshots).
 */
import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { config } from '../config.js';
import { getServerForTenant } from './servers.js';
import { resolveTenantApiUrl } from './worker/tenant-url.js';
import { getPlatformVersion } from './platform-version.js';

export const ANALYTICS_PERIODS = ['7d', '30d', '90d'] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

export type TenantAnalyticsOk = {
  ok: true;
  tenantId: string;
  instanceId: string;
  name: string;
  status: string;
  serverId: string | null;
  online: true;
  analytics: Record<string, unknown>;
  platformBehind: boolean;
};

export type TenantAnalyticsErr = {
  ok: false;
  tenantId: string;
  instanceId: string;
  name: string;
  status: string;
  serverId: string | null;
  online: false;
  error: string;
  platformBehind: boolean;
};

export type FleetRow = TenantAnalyticsOk | TenantAnalyticsErr;

type TenantRow = {
  id: string;
  instanceId: string;
  name: string;
  status: string;
  serverId: string | null;
  apiDomain: string;
  apiPort: number;
};

export function parseAnalyticsPeriod(q: string | undefined): AnalyticsPeriod {
  const v = (q ?? '7d').toLowerCase();
  return (ANALYTICS_PERIODS as readonly string[]).includes(v)
    ? (v as AnalyticsPeriod)
    : '7d';
}

export async function fetchTenantAnalytics(
  tenant: TenantRow,
  period: string,
  saCode: number,
): Promise<FleetRow> {
  const base = {
    tenantId: tenant.id,
    instanceId: tenant.instanceId,
    name: tenant.name,
    status: tenant.status,
    serverId: tenant.serverId,
    platformBehind: false,
  };

  if (!config.SUPERVISOR_SHARED_SECRET) {
    return { ...base, ok: false, online: false, error: 'SUPERVISOR_SHARED_SECRET unset' };
  }

  try {
    const server = await getServerForTenant(tenant.serverId);
    const apiBase = resolveTenantApiUrl(tenant, server);
    const res = await fetch(
      `${apiBase}/supervisor/analytics?period=${encodeURIComponent(period)}`,
      {
        headers: { 'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET },
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        ...base,
        ok: false,
        online: false,
        error: body.error || `HTTP ${res.status}`,
      };
    }
    const analytics = (await res.json()) as Record<string, unknown>;
    const pv = analytics.platformVersion as { code?: number } | undefined;
    const tenantCode = typeof pv?.code === 'number' ? pv.code : 0;
    return {
      ...base,
      ok: true,
      online: true,
      analytics,
      platformBehind: saCode > 0 && tenantCode > 0 && tenantCode < saCode,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, ok: false, online: false, error: message };
  }
}

export function summarizeFleet(
  rows: FleetRow[],
  period: string,
  saVersion: { name: string; code: number },
) {
  let clientWrote = 0;
  let botAccepted = 0;
  let convertedFromBot = 0;
  let briefsSubmitted = 0;
  let invocations = 0;
  let drops = 0;
  let botFailures = 0;
  let online = 0;
  let withAlerts = 0;
  let platformBehind = 0;
  let claudeAuthBad = 0;
  let adminInactive = 0;

  for (const row of rows) {
    if (!row.ok) continue;
    online += 1;
    if (row.platformBehind) platformBehind += 1;
    const a = row.analytics as {
      funnel?: {
        clientWrote?: number;
        botAccepted?: number;
        convertedFromBot?: number;
        briefsSubmitted?: number;
      };
      claude?: {
        invocations?: number;
        busy?: number;
        timeout?: number;
        botFailureMessages?: number;
        auth?: { loggedIn?: boolean; binaryOk?: boolean; sessionExpired?: boolean };
      };
      alerts?: string[];
    };
    const alerts = a.alerts ?? [];
    if (alerts.includes('admin_inactive') || alerts.includes('admin_never_logged_in')) {
      adminInactive += 1;
    }
    clientWrote += a.funnel?.clientWrote ?? 0;
    botAccepted += a.funnel?.botAccepted ?? 0;
    convertedFromBot += a.funnel?.convertedFromBot ?? 0;
    briefsSubmitted += a.funnel?.briefsSubmitted ?? 0;
    invocations += a.claude?.invocations ?? 0;
    drops += (a.claude?.busy ?? 0) + (a.claude?.timeout ?? 0);
    botFailures += a.claude?.botFailureMessages ?? 0;
    if ((a.alerts?.length ?? 0) > 0) withAlerts += 1;
    const auth = a.claude?.auth;
    if (auth && (!auth.binaryOk || !auth.loggedIn || auth.sessionExpired)) claudeAuthBad += 1;
  }

  const pct = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;

  return {
    period,
    saVersion,
    tenantsTotal: rows.length,
    tenantsOnline: online,
    tenantsOffline: rows.length - online,
    tenantsWithAlerts: withAlerts,
    platformBehind,
    claudeAuthBad,
    adminInactive,
    funnel: {
      clientWrote,
      botAccepted,
      convertedFromBot,
      briefsSubmitted,
      botAcceptRate: pct(botAccepted, clientWrote),
      conversionFromBotRate: pct(convertedFromBot, botAccepted),
    },
    claude: {
      invocations,
      drops,
      dropRate: pct(drops, invocations),
      botFailureMessages: botFailures,
    },
  };
}

export function sortFleetRows(rows: FleetRow[]): FleetRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const aAlert = a.ok ? ((a.analytics.alerts as string[] | undefined)?.length ?? 0) : 99;
    const bAlert = b.ok ? ((b.analytics.alerts as string[] | undefined)?.length ?? 0) : 99;
    if (aAlert !== bAlert) return bAlert - aAlert;
    const aWrote = a.ok
      ? ((a.analytics.funnel as { clientWrote?: number } | undefined)?.clientWrote ?? 0)
      : -1;
    const bWrote = b.ok
      ? ((b.analytics.funnel as { clientWrote?: number } | undefined)?.clientWrote ?? 0)
      : -1;
    return bWrote - aWrote;
  });
  return sorted;
}

function isFleetRow(value: unknown): value is FleetRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o.tenantId === 'string' && typeof o.ok === 'boolean';
}

export async function listActiveTenants(): Promise<TenantRow[]> {
  return prisma.tenant.findMany({
    where: { status: { in: ['active', 'provisioned'] } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      instanceId: true,
      name: true,
      status: true,
      serverId: true,
      apiDomain: true,
      apiPort: true,
    },
  });
}

/** Instant read from DB — no tenant HTTP. */
export async function readFleetFromCache(period: AnalyticsPeriod): Promise<{
  generatedAt: string | null;
  summary: ReturnType<typeof summarizeFleet> | null;
  tenants: FleetRow[];
  source: 'cache';
  stale: boolean;
}> {
  const saVersion = getPlatformVersion();
  const tenants = await listActiveTenants();
  if (tenants.length === 0) {
    return {
      generatedAt: null,
      summary: summarizeFleet([], period, { name: saVersion.name, code: saVersion.code }),
      tenants: [],
      source: 'cache',
      stale: true,
    };
  }

  const cached = await prisma.tenantAnalyticsCache.findMany({
    where: {
      period,
      tenantId: { in: tenants.map((t) => t.id) },
    },
  });
  const byTenant = new Map(cached.map((c) => [c.tenantId, c]));

  const rows: FleetRow[] = [];
  let newest: Date | null = null;
  let oldest: Date | null = null;
  let missing = 0;

  for (const t of tenants) {
    const hit = byTenant.get(t.id);
    if (!hit || !isFleetRow(hit.payload)) {
      missing += 1;
      rows.push({
        ok: false,
        tenantId: t.id,
        instanceId: t.instanceId,
        name: t.name,
        status: t.status,
        serverId: t.serverId,
        online: false,
        error: 'Ще немає кешу — оновлюємо…',
        platformBehind: false,
      });
      continue;
    }
    // Keep name/status fresh from registry even if payload is older.
    const row = {
      ...hit.payload,
      name: t.name,
      status: t.status,
      instanceId: t.instanceId,
      serverId: t.serverId,
    } as FleetRow;
    rows.push(row);
    if (!newest || hit.fetchedAt > newest) newest = hit.fetchedAt;
    if (!oldest || hit.fetchedAt < oldest) oldest = hit.fetchedAt;
  }

  const sorted = sortFleetRows(rows);
  return {
    generatedAt: newest?.toISOString() ?? null,
    summary: summarizeFleet(sorted, period, { name: saVersion.name, code: saVersion.code }),
    tenants: sorted,
    source: 'cache',
    stale: missing > 0 || !newest,
  };
}

export async function upsertTenantAnalyticsCache(
  tenantId: string,
  period: AnalyticsPeriod,
  row: FleetRow,
  fetchedAt = new Date(),
): Promise<void> {
  await prisma.tenantAnalyticsCache.upsert({
    where: { tenantId_period: { tenantId, period } },
    create: {
      tenantId,
      period,
      payload: row as unknown as Prisma.InputJsonValue,
      fetchedAt,
    },
    update: {
      payload: row as unknown as Prisma.InputJsonValue,
      fetchedAt,
    },
  });
}

/** Live fan-out to tenants, persist each row, return fleet payload. */
export async function refreshFleetAnalytics(period: AnalyticsPeriod): Promise<{
  generatedAt: string;
  summary: ReturnType<typeof summarizeFleet>;
  tenants: FleetRow[];
  source: 'live';
  stale: false;
}> {
  const saVersion = getPlatformVersion();
  const tenants = await listActiveTenants();
  const fetchedAt = new Date();

  const rows = await Promise.all(
    tenants.map(async (t) => {
      const row = await fetchTenantAnalytics(t, period, saVersion.code);
      try {
        await upsertTenantAnalyticsCache(t.id, period, row, fetchedAt);
      } catch (err) {
        console.warn('[analytics-cache] upsert failed', t.instanceId, err);
      }
      return row;
    }),
  );

  const sorted = sortFleetRows(rows);
  return {
    generatedAt: fetchedAt.toISOString(),
    summary: summarizeFleet(sorted, period, { name: saVersion.name, code: saVersion.code }),
    tenants: sorted,
    source: 'live',
    stale: false,
  };
}

export async function refreshOneTenantAnalytics(
  tenantId: string,
  period: AnalyticsPeriod,
): Promise<FleetRow | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      instanceId: true,
      name: true,
      status: true,
      serverId: true,
      apiDomain: true,
      apiPort: true,
    },
  });
  if (!tenant) return null;
  const saVersion = getPlatformVersion();
  const row = await fetchTenantAnalytics(tenant, period, saVersion.code);
  await upsertTenantAnalyticsCache(tenant.id, period, row);
  return row;
}

export async function readOneTenantFromCache(
  tenantId: string,
  period: AnalyticsPeriod,
): Promise<FleetRow | null> {
  const hit = await prisma.tenantAnalyticsCache.findUnique({
    where: { tenantId_period: { tenantId, period } },
  });
  if (!hit || !isFleetRow(hit.payload)) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, status: true, instanceId: true, serverId: true },
  });
  if (!tenant) return hit.payload;
  return {
    ...hit.payload,
    name: tenant.name,
    status: tenant.status,
    instanceId: tenant.instanceId,
    serverId: tenant.serverId,
  } as FleetRow;
}
