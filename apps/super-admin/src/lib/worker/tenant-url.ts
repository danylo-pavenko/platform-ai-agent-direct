import type { Server, Tenant } from '../../generated/prisma/client.js';
import { isLocalServer } from '../servers.js';

/**
 * Base URL for HTTP calls from Super Admin to a tenant backend.
 * - Local worker: loopback + apiPort (co-located with SA)
 * - Remote worker: public https://{apiDomain} (DNS must point at worker IP)
 */
export function resolveTenantApiUrl(
  tenant: Pick<Tenant, 'apiDomain' | 'apiPort'>,
  server: Pick<Server, 'kind'> | null | undefined,
): string {
  if (!server || isLocalServer(server)) {
    return `http://127.0.0.1:${tenant.apiPort}`;
  }
  const host = tenant.apiDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host}`;
}

/** OAuth callback path on tenant backend. */
export function resolveTenantOAuthCallbackUrl(
  tenant: Pick<Tenant, 'apiDomain' | 'apiPort'>,
  server: Pick<Server, 'kind'> | null | undefined,
  queryString: string,
): string {
  const base = resolveTenantApiUrl(tenant, server);
  return `${base}/settings/meta/oauth-callback?${queryString}`;
}

export function resolveTenantWebhookUrl(
  tenant: Pick<Tenant, 'apiDomain' | 'apiPort'>,
  server: Pick<Server, 'kind'> | null | undefined,
): string {
  return `${resolveTenantApiUrl(tenant, server)}/webhooks/instagram`;
}

/** DNS A-record hints for platform tenants on a worker. */
export function dnsHintsForTenant(
  tenant: Pick<Tenant, 'apiDomain' | 'adminDomain'>,
  server: Pick<Server, 'publicIp' | 'name'>,
): { records: Array<{ type: 'A'; host: string; value: string }>; workerName: string; publicIp: string } {
  return {
    workerName: server.name,
    publicIp: server.publicIp,
    records: [
      { type: 'A', host: tenant.apiDomain, value: server.publicIp },
      { type: 'A', host: tenant.adminDomain, value: server.publicIp },
    ],
  };
}
