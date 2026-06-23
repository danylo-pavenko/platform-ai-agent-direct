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

type WebhookEntryLike = {
  id?: string;
  messaging?: Array<{ recipient?: { id?: string }; sender?: { id?: string } }>;
  standby?: Array<{ recipient?: { id?: string }; sender?: { id?: string } }>;
  changes?: Array<{
    value?: { recipient?: { id?: string }; sender?: { id?: string } };
  }>;
};

/**
 * IDs to match against tenant routing. For DM `messaging` events, `entry.id` is
 * usually the sender — use `recipient.id` instead. For `message_edit` etc.,
 * `entry.id` is the business IG account.
 */
export function collectWebhookRoutingCandidateIds(
  entries: WebhookEntryLike[],
): Set<string> {
  const fromRecipients = new Set<string>();
  const fromEntryId = new Set<string>();
  let hasMessaging = false;

  for (const entry of entries) {
    if (entry.id && entry.id !== '0') fromEntryId.add(entry.id);

    for (const m of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      hasMessaging = true;
      if (m.recipient?.id) fromRecipients.add(m.recipient.id);
    }
    for (const c of entry.changes ?? []) {
      if (c.value?.recipient?.id) fromRecipients.add(c.value.recipient.id);
    }
  }

  if (hasMessaging && fromRecipients.size > 0) {
    return fromRecipients;
  }

  const combined = new Set<string>([...fromRecipients, ...fromEntryId]);
  return combined;
}

/** All IDs seen in payload — for debug logs only. */
export function collectWebhookDebugCandidateIds(
  entries: WebhookEntryLike[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.id && entry.id !== '0') ids.add(entry.id);
    for (const m of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      if (m.recipient?.id) ids.add(m.recipient.id);
      if (m.sender?.id) ids.add(m.sender.id);
    }
    for (const c of entry.changes ?? []) {
      if (c.value?.recipient?.id) ids.add(c.value.recipient.id);
      if (c.value?.sender?.id) ids.add(c.value.sender.id);
    }
  }
  return ids;
}

/**
 * Merge auto-synced routing IDs with existing tenant extras.
 * When the primary IG account changes, drop stale IDs from the previous account.
 */
export function mergeTenantInstagramRoutingIds(
  tenant: Pick<Tenant, 'instagramUserId' | 'instagramRoutingIds'>,
  syncedIds: string[],
  newPrimaryId: string,
): string[] {
  const merged = new Set(syncedIds);
  const prevPrimary = tenant.instagramUserId;
  const accountChanged = Boolean(prevPrimary && prevPrimary !== newPrimaryId);

  if (!accountChanged) {
    for (const id of collectTenantInstagramRoutingIds(tenant as Tenant)) {
      if (id !== prevPrimary && id !== newPrimaryId) merged.add(id);
    }
  }

  return [...merged];
}
