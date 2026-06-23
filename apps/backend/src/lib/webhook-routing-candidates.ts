/** Tenant IG routing fields — shared by hub tests and super-admin webhook routing. */
export interface TenantRoutingFields {
  instagramUserId: string | null;
  instagramRoutingIds: unknown;
}

export function collectTenantRoutingIdSet(tenant: TenantRoutingFields): Set<string> {
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

export type WebhookEntryLike = {
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

  return new Set<string>([...fromRecipients, ...fromEntryId]);
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
  tenant: TenantRoutingFields,
  syncedIds: string[],
  newPrimaryId: string,
): string[] {
  const merged = new Set(syncedIds);
  const prevPrimary = tenant.instagramUserId;
  const accountChanged = Boolean(prevPrimary && prevPrimary !== newPrimaryId);

  if (!accountChanged) {
    for (const id of collectTenantRoutingIdSet(tenant)) {
      if (id !== prevPrimary && id !== newPrimaryId) merged.add(id);
    }
  }

  return [...merged];
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

export function tenantMatchesWebhookCandidates(
  tenant: TenantRoutingFields,
  candidateIds: Iterable<string>,
): boolean {
  const routing = collectTenantRoutingIdSet(tenant);
  for (const id of candidateIds) {
    if (routing.has(id)) return true;
  }
  return false;
}
