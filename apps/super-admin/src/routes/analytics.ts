/**
 * Super Admin analytics — fan-out to tenant /supervisor/analytics.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { getServerForTenant } from '../lib/servers.js';
import { resolveTenantApiUrl } from '../lib/worker/tenant-url.js';
import { getPlatformVersion } from '../lib/platform-version.js';

const PeriodSchema = z.enum(['7d', '30d', '90d']).default('7d');

type TenantAnalyticsOk = {
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

type TenantAnalyticsErr = {
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

type FleetRow = TenantAnalyticsOk | TenantAnalyticsErr;

async function fetchTenantAnalytics(
  tenant: {
    id: string;
    instanceId: string;
    name: string;
    status: string;
    serverId: string | null;
    apiDomain: string;
    apiPort: number;
  },
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

function summarizeFleet(rows: FleetRow[], period: string, saVersion: { name: string; code: number }) {
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

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [app.authenticate] };

  app.get<{ Querystring: { period?: string } }>(
    '/api/analytics/fleet',
    auth,
    async (req, reply) => {
      const parsed = PeriodSchema.safeParse(req.query.period ?? '7d');
      const period = parsed.success ? parsed.data : '7d';
      const saVersion = getPlatformVersion();

      const tenants = await prisma.tenant.findMany({
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

      const rows = await Promise.all(
        tenants.map((t) => fetchTenantAnalytics(t, period, saVersion.code)),
      );

      // Sort: alerts / offline first, then by clientWrote desc
      rows.sort((a, b) => {
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

      return {
        generatedAt: new Date().toISOString(),
        summary: summarizeFleet(rows, period, {
          name: saVersion.name,
          code: saVersion.code,
        }),
        tenants: rows,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/api/analytics/tenants/:id',
    auth,
    async (req, reply) => {
      const parsed = PeriodSchema.safeParse(req.query.period ?? '7d');
      const period = parsed.success ? parsed.data : '7d';
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
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
      if (!tenant) return reply.status(404).send({ error: 'Not found' });

      const saVersion = getPlatformVersion();
      const row = await fetchTenantAnalytics(tenant, period, saVersion.code);
      return { generatedAt: new Date().toISOString(), saVersion, tenant: row };
    },
  );
}
