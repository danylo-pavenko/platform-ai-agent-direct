import type { Tenant } from '../generated/prisma/client.js';
import {
  collectTenantRoutingIdSet,
  collectWebhookDebugCandidateIds,
  collectWebhookRoutingCandidateIds,
  mergeTenantInstagramRoutingIds,
  normalizeInstagramRoutingIds,
  tenantMatchesWebhookCandidates as tenantMatchesCandidates,
  type TenantRoutingFields,
} from './webhook-routing-candidates.js';

export {
  collectWebhookDebugCandidateIds,
  collectWebhookRoutingCandidateIds,
  mergeTenantInstagramRoutingIds,
  normalizeInstagramRoutingIds,
};

/** All Instagram IDs that should route webhooks to this tenant. */
export function collectTenantInstagramRoutingIds(tenant: Tenant): Set<string> {
  return collectTenantRoutingIdSet(tenant as TenantRoutingFields);
}

export function tenantMatchesWebhookCandidates(
  tenant: Tenant,
  candidateIds: Iterable<string>,
): boolean {
  return tenantMatchesCandidates(tenant as TenantRoutingFields, candidateIds);
}
