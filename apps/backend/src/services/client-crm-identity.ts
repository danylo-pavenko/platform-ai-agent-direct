/**
 * Per-provider CRM client identities + denormalized Client.crmBuyerId primary.
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { getCrmForAction } from '../lib/crm-routing.js';
import {
  isCrmProviderName,
  type CrmProviderName,
} from '../lib/crm-providers.js';

const log = pino({ name: 'client-crm-identity' });

export type ClientCrmIdentityStatus = 'active' | 'legacy';
export type ClientCrmIdentitySource =
  | 'phone'
  | 'phone_match'
  | 'booking'
  | 'manual'
  | 'migration'
  | 'upsert'
  | 'name_match';

export type ClientCrmIdentityRow = {
  id: string;
  clientId: string;
  provider: string;
  externalId: string;
  status: string;
  source: string;
  linkedAt: Date;
  updatedAt: Date;
};

/** Resolve which provider should own Client.crmBuyerId denorm. */
export async function resolvePrimaryCrmProvider(): Promise<CrmProviderName | null> {
  const booking = await getCrmForAction('booking');
  if (booking) return booking.provider;
  const upsert = await getCrmForAction('client_upsert');
  return upsert?.provider ?? null;
}

export async function getClientCrmId(
  clientId: string,
  provider: string,
  opts?: { includeLegacy?: boolean },
): Promise<string | null> {
  if (!provider.trim()) return null;
  const row = await prisma.clientCrmIdentity.findUnique({
    where: {
      clientId_provider: { clientId, provider },
    },
    select: { externalId: true, status: true },
  });
  if (!row?.externalId?.trim()) return null;
  if (row.status === 'legacy' && !opts?.includeLegacy) return null;
  return row.externalId.trim();
}

export async function listClientCrmIdentities(
  clientId: string,
): Promise<ClientCrmIdentityRow[]> {
  return prisma.clientCrmIdentity.findMany({
    where: { clientId },
    orderBy: [{ status: 'asc' }, { provider: 'asc' }],
  });
}

export async function upsertClientCrmIdentity(opts: {
  clientId: string;
  provider: string;
  externalId: string;
  source: ClientCrmIdentitySource;
  status?: ClientCrmIdentityStatus;
  /** When true, replace externalId even if another id already stored for this provider. */
  force?: boolean;
}): Promise<ClientCrmIdentityRow | null> {
  const provider = opts.provider.trim();
  const externalId = opts.externalId.trim();
  if (!provider || !externalId) return null;

  const existing = await prisma.clientCrmIdentity.findUnique({
    where: { clientId_provider: { clientId: opts.clientId, provider } },
  });

  if (existing && existing.externalId !== externalId && !opts.force) {
    log.info(
      {
        clientId: opts.clientId,
        provider,
        existing: existing.externalId,
        incoming: externalId,
      },
      'Keeping existing CRM identity (differs from incoming)',
    );
    return existing;
  }

  // Another client may already own this (provider, externalId) — steal only with force.
  const byExternal = await prisma.clientCrmIdentity.findUnique({
    where: { provider_externalId: { provider, externalId } },
  });
  if (byExternal && byExternal.clientId !== opts.clientId) {
    if (!opts.force) {
      log.warn(
        {
          clientId: opts.clientId,
          otherClientId: byExternal.clientId,
          provider,
          externalId,
        },
        'CRM identity already linked to another client',
      );
      return null;
    }
    await prisma.clientCrmIdentity.delete({ where: { id: byExternal.id } });
  }

  const status = opts.status ?? 'active';
  const row = await prisma.clientCrmIdentity.upsert({
    where: { clientId_provider: { clientId: opts.clientId, provider } },
    create: {
      clientId: opts.clientId,
      provider,
      externalId,
      status,
      source: opts.source,
      linkedAt: new Date(),
    },
    update: {
      externalId,
      status,
      source: opts.source,
      linkedAt: new Date(),
    },
  });
  return row;
}

export async function markProviderLegacy(
  clientId: string,
  provider: string,
): Promise<void> {
  await prisma.clientCrmIdentity.updateMany({
    where: { clientId, provider },
    data: { status: 'legacy' },
  });
}

export async function markProviderLegacyForAllClients(
  provider: string,
): Promise<number> {
  const result = await prisma.clientCrmIdentity.updateMany({
    where: { provider, status: { not: 'legacy' } },
    data: { status: 'legacy' },
  });
  return result.count;
}

/**
 * Set Client.crmBuyerId / crmProvider from identity for current primary routing.
 * If no identity for primary — clear denorm (legacy ids stay in ClientCrmIdentity).
 */
export async function syncClientPrimaryFromRouting(
  clientId: string,
): Promise<{ provider: CrmProviderName | null; crmBuyerId: string | null }> {
  const primary = await resolvePrimaryCrmProvider();
  if (!primary) {
    await prisma.client.update({
      where: { id: clientId },
      data: { crmBuyerId: null, crmProvider: null, crmLinkedAt: null },
    });
    return { provider: null, crmBuyerId: null };
  }

  const id = await getClientCrmId(clientId, primary);
  if (!id) {
    await prisma.client.update({
      where: { id: clientId },
      data: { crmBuyerId: null, crmProvider: null, crmLinkedAt: null },
    });
    return { provider: primary, crmBuyerId: null };
  }

  const identity = await prisma.clientCrmIdentity.findUnique({
    where: { clientId_provider: { clientId, provider: primary } },
    select: { linkedAt: true, status: true },
  });

  // Only promote active identities to denorm primary.
  if (identity?.status === 'legacy') {
    await prisma.client.update({
      where: { id: clientId },
      data: { crmBuyerId: null, crmProvider: null, crmLinkedAt: null },
    });
    return { provider: primary, crmBuyerId: null };
  }

  await prisma.client.update({
    where: { id: clientId },
    data: {
      crmBuyerId: id,
      crmProvider: primary,
      crmLinkedAt: identity?.linkedAt ?? new Date(),
    },
  });
  return { provider: primary, crmBuyerId: id };
}

/** Remove one provider identity; optionally clear denorm if it was that provider. */
export async function removeClientCrmIdentity(
  clientId: string,
  provider: string | 'all',
): Promise<void> {
  if (provider === 'all') {
    await prisma.clientCrmIdentity.deleteMany({ where: { clientId } });
    await prisma.client.update({
      where: { id: clientId },
      data: { crmBuyerId: null, crmProvider: null, crmLinkedAt: null },
    });
    return;
  }

  await prisma.clientCrmIdentity.deleteMany({ where: { clientId, provider } });
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { crmProvider: true },
  });
  if (client?.crmProvider === provider) {
    await syncClientPrimaryFromRouting(clientId);
  }
}

/**
 * Prefer identity for provider; fall back to denorm only when providers match.
 * Cancel of a legacy visit may pass includeLegacy so BeautyPro UUID still resolves.
 */
export async function resolveClientCrmBuyerIdForProvider(
  client: {
    id: string;
    crmBuyerId?: string | null;
    crmProvider?: string | null;
  },
  provider: string,
  opts?: { includeLegacy?: boolean },
): Promise<string | undefined> {
  const fromIdentity = await getClientCrmId(client.id, provider, opts);
  if (fromIdentity) return fromIdentity;
  const denorm = client.crmBuyerId?.trim();
  if (
    denorm &&
    (!client.crmProvider || client.crmProvider === provider)
  ) {
    return denorm;
  }
  return undefined;
}

export function isValidIdentityProvider(value: string): value is CrmProviderName {
  return isCrmProviderName(value);
}
