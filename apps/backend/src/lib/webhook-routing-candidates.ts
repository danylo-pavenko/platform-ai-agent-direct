/** Tenant IG routing fields — keep in sync with apps/super-admin/src/lib/webhook-routing-candidates.ts */
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

export type WebhookMessagingLike = {
  recipient?: { id?: string };
  sender?: { id?: string };
  message?: { is_echo?: boolean };
};

export type WebhookEntryLike = {
  id?: string;
  messaging?: WebhookMessagingLike[];
  standby?: WebhookMessagingLike[];
  changes?: Array<{
    value?: {
      recipient?: { id?: string };
      sender?: { id?: string };
      message?: { is_echo?: boolean };
    };
  }>;
};

export type TenantWebhookTargetKind = 'inbound' | 'echo';

export function webhookMessagingIsEcho(m: WebhookMessagingLike | undefined): boolean {
  return m?.message?.is_echo === true;
}

/** Page-originated DM (manager/app inbox or our own send). Recipient is the client IGSID. */
export function webhookPayloadHasEcho(entries: WebhookEntryLike[]): boolean {
  for (const entry of entries) {
    for (const m of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      if (webhookMessagingIsEcho(m)) return true;
    }
    for (const c of entry.changes ?? []) {
      if (c.value?.message?.is_echo === true) return true;
    }
  }
  return false;
}

/** Client inbound, reactions, edits — anything the existing tenant webhook should still see. */
export function webhookPayloadHasNonEchoWork(entries: WebhookEntryLike[]): boolean {
  for (const entry of entries) {
    for (const m of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      if (!m.message) return true;
      if (m.message.is_echo !== true) return true;
    }
    for (const c of entry.changes ?? []) {
      if (c.value?.message?.is_echo === true) continue;
      return true;
    }
  }
  return false;
}

/**
 * Hub → tenant paths. Echo-only POSTs skip inbound so processMessageEvent is never entered.
 * Mixed batches keep one inbound POST (echo still skipped there) plus one echo POST.
 */
export function selectTenantWebhookTargetKinds(
  entries: WebhookEntryLike[],
): TenantWebhookTargetKind[] {
  const echo = webhookPayloadHasEcho(entries);
  const inbound = webhookPayloadHasNonEchoWork(entries);
  const kinds: TenantWebhookTargetKind[] = [];
  if (inbound || !echo) kinds.push('inbound');
  if (echo) kinds.push('echo');
  return kinds;
}

/**
 * IDs to match against tenant routing.
 * Inbound DM: `entry.id` is often the client — use `recipient.id` (business).
 * Echo: recipient is the client IGSID — use `sender.id` + `entry.id` (business), never the client.
 */
export function collectWebhookRoutingCandidateIds(
  entries: WebhookEntryLike[],
): Set<string> {
  const fromInboundRecipients = new Set<string>();
  const fromEchoBusiness = new Set<string>();
  const fromEntryId = new Set<string>();
  const fromChangeRecipients = new Set<string>();
  let hasInboundMessaging = false;
  let hasEchoMessaging = false;

  for (const entry of entries) {
    if (entry.id && entry.id !== '0') fromEntryId.add(entry.id);

    for (const m of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      if (webhookMessagingIsEcho(m)) {
        hasEchoMessaging = true;
        if (m.sender?.id) fromEchoBusiness.add(m.sender.id);
      } else {
        hasInboundMessaging = true;
        if (m.recipient?.id) fromInboundRecipients.add(m.recipient.id);
      }
    }
    for (const c of entry.changes ?? []) {
      if (c.value?.message?.is_echo === true) {
        hasEchoMessaging = true;
        if (c.value.sender?.id) fromEchoBusiness.add(c.value.sender.id);
      } else if (c.value?.recipient?.id) {
        fromChangeRecipients.add(c.value.recipient.id);
      }
    }
  }

  const ids = new Set<string>();
  if (hasInboundMessaging) {
    for (const id of fromInboundRecipients) ids.add(id);
  }
  if (hasEchoMessaging) {
    for (const id of fromEchoBusiness) ids.add(id);
    for (const id of fromEntryId) ids.add(id);
  }
  for (const id of fromChangeRecipients) ids.add(id);

  if (ids.size > 0) return ids;
  return new Set<string>(fromEntryId);
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
