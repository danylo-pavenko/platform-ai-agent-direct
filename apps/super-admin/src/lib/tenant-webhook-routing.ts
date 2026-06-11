import type { Tenant } from '@prisma/client';

/** All Instagram IDs that should route webhooks to this tenant. */
export function collectTenantInstagramRoutingIds(tenant: Tenant): Set<string> {
  const ids = new Set<string>();
  if (tenant.instagramUserId) ids.add(tenant.instagramUserId);

  const extra = tenant.instagramRoutingIds;
  if (Array.isArray(extra)) {
    for (const id of extra) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }

  return ids;
}

export function tenantMatchesWebhookCandidates(
  tenant: Tenant,
  candidateIds: Iterable<string>,
): boolean {
  const routing = collectTenantInstagramRoutingIds(tenant);
  for (const id of candidateIds) {
    if (routing.has(id)) return true;
  }
  return false;
}

export function normalizeInstagramRoutingIds(
  primaryId: string,
  extraIds?: string[],
): string[] {
  const all = new Set<string>();
  if (primaryId) all.add(primaryId);
  for (const id of extraIds ?? []) {
    if (id && id !== primaryId) all.add(id);
  }
  return [...all];
}
