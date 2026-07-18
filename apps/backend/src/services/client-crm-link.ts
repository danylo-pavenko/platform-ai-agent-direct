/**
 * Link local Client ↔ CRM buyer/client id + fetch visit history for booking context.
 *
 * Auto-link runs when the client shares a phone (agent tool / heuristic / admin).
 * Manual attach is available from admin (POST crm-link with crmBuyerId).
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { resolveCrmProvider } from '../lib/crm-routing.js';
import { isCrmProviderName, type CrmProviderName } from '../lib/crm-providers.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmVisitHistoryItem } from './crm/types.js';

const log = pino({ name: 'client-crm-link' });

export interface LinkClientResult {
  linked: boolean;
  crmBuyerId: string | null;
  provider: CrmProviderName | null;
  source: 'existing' | 'manual' | 'phone_match' | 'upsert' | 'unlinked' | 'skipped';
  message?: string;
}

async function resolveLinkProvider(
  preferred?: string | null,
): Promise<CrmProviderName> {
  if (preferred && isCrmProviderName(preferred)) {
    const adapter = getCrmAdapter(preferred);
    if (adapter.findClient || adapter.fetchClientHistory) return preferred;
  }
  // Prefer booking CRM for salon history, fall back to client_upsert
  const booking = await resolveCrmProvider('booking');
  const bookingAdapter = getCrmAdapter(booking);
  if (bookingAdapter.findClient || bookingAdapter.fetchClientHistory) {
    return booking;
  }
  return resolveCrmProvider('client_upsert');
}

/**
 * Attach / find / unlink CRM client id on our Client row.
 * Does NOT require CRM_WRITE_ENABLED for read-only phone match (history use case).
 */
export async function linkClientToCrm(
  clientId: string,
  opts?: {
    /** Explicit CRM id (admin manual). Pass null to unlink. */
    crmBuyerId?: string | null;
    /** Also upsert contact into CRM when write is enabled (default true). */
    upsert?: boolean;
  },
): Promise<LinkClientResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    return {
      linked: false,
      crmBuyerId: null,
      provider: null,
      source: 'skipped',
      message: 'Client not found',
    };
  }

  // Unlink
  if (opts && 'crmBuyerId' in opts && opts.crmBuyerId === null) {
    await prisma.client.update({
      where: { id: clientId },
      data: { crmBuyerId: null, crmProvider: null, crmLinkedAt: null },
    });
    log.info({ clientId }, 'Unlinked client from CRM');
    return {
      linked: false,
      crmBuyerId: null,
      provider: null,
      source: 'unlinked',
    };
  }

  // Manual attach
  if (typeof opts?.crmBuyerId === 'string' && opts.crmBuyerId.trim()) {
    const provider = await resolveLinkProvider(client.crmProvider);
    const crmBuyerId = opts.crmBuyerId.trim();
    await prisma.client.update({
      where: { id: clientId },
      data: {
        crmBuyerId,
        crmProvider: provider,
        crmLinkedAt: new Date(),
      },
    });
    log.info({ clientId, crmBuyerId, provider }, 'Manually linked client to CRM');
    return {
      linked: true,
      crmBuyerId,
      provider,
      source: 'manual',
    };
  }

  if (client.crmBuyerId) {
    return {
      linked: true,
      crmBuyerId: client.crmBuyerId,
      provider: isCrmProviderName(client.crmProvider ?? '')
        ? (client.crmProvider as CrmProviderName)
        : await resolveLinkProvider(client.crmProvider),
      source: 'existing',
    };
  }

  const provider = await resolveLinkProvider(client.crmProvider);
  const crm = getCrmAdapter(provider);

  if (!crm.findClient) {
    return {
      linked: false,
      crmBuyerId: null,
      provider,
      source: 'skipped',
      message: `CRM ${provider} не підтримує пошук клієнта`,
    };
  }

  if (!client.phone && !client.email) {
    return {
      linked: false,
      crmBuyerId: null,
      provider,
      source: 'skipped',
      message: 'Немає телефону або email для пошуку в CRM',
    };
  }

  let matchedId: string | null = null;
  try {
    const match = await crm.findClient({
      phone: client.phone ?? undefined,
      email: client.email ?? undefined,
      instagramUsername: client.igUsername ?? undefined,
    });
    matchedId = match?.crmBuyerId ?? null;
  } catch (err) {
    log.warn({ err, clientId, provider }, 'findClient failed');
    return {
      linked: false,
      crmBuyerId: null,
      provider,
      source: 'skipped',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (matchedId) {
    await prisma.client.update({
      where: { id: clientId },
      data: {
        crmBuyerId: matchedId,
        crmProvider: provider,
        crmLinkedAt: new Date(),
      },
    });
    log.info({ clientId, crmBuyerId: matchedId, provider }, 'Linked client by phone/email match');
    return {
      linked: true,
      crmBuyerId: matchedId,
      provider,
      source: 'phone_match',
    };
  }

  // Optional create in CRM (write path)
  const shouldUpsert = opts?.upsert !== false && (await isCrmWriteEnabled());
  if (shouldUpsert && crm.upsertClient) {
    const fullName =
      client.displayName ??
      client.igFullName ??
      (client.igUsername ? `@${client.igUsername}` : null);
    if (!fullName) {
      return {
        linked: false,
        crmBuyerId: null,
        provider,
        source: 'skipped',
        message: 'Клієнта не знайдено в CRM і немає імені для створення',
      };
    }
    try {
      const created = await crm.upsertClient(null, {
        fullName,
        phone: client.phone ?? undefined,
        email: client.email ?? undefined,
        instagramUsername: client.igUsername ?? undefined,
      });
      await prisma.client.update({
        where: { id: clientId },
        data: {
          crmBuyerId: created.crmBuyerId,
          crmProvider: provider,
          crmLinkedAt: new Date(),
        },
      });
      log.info(
        { clientId, crmBuyerId: created.crmBuyerId, provider },
        'Created CRM client and linked',
      );
      return {
        linked: true,
        crmBuyerId: created.crmBuyerId,
        provider,
        source: 'upsert',
      };
    } catch (err) {
      log.warn({ err, clientId }, 'upsertClient during link failed');
      return {
        linked: false,
        crmBuyerId: null,
        provider,
        source: 'skipped',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    linked: false,
    crmBuyerId: null,
    provider,
    source: 'skipped',
    message: 'Клієнта з таким телефоном не знайдено в CRM',
  };
}

/** Persist CRM client id learned during booking without overwriting a different link. */
export async function persistCrmBuyerIdFromBooking(
  clientId: string,
  crmBuyerId: string,
  provider: string,
): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { crmBuyerId: true },
  });
  if (!client) return;
  if (client.crmBuyerId && client.crmBuyerId !== crmBuyerId) {
    log.info(
      { clientId, existing: client.crmBuyerId, fromBooking: crmBuyerId },
      'Keeping existing crmBuyerId (differs from booking)',
    );
    return;
  }
  if (client.crmBuyerId === crmBuyerId) return;

  await prisma.client.update({
    where: { id: clientId },
    data: {
      crmBuyerId,
      crmProvider: isCrmProviderName(provider) ? provider : provider,
      crmLinkedAt: new Date(),
    },
  });
  log.info({ clientId, crmBuyerId, provider }, 'Linked client from booking');
}

export function formatCrmHistoryForPrompt(
  items: CrmVisitHistoryItem[],
  opts?: { limit?: number },
): string {
  const limit = opts?.limit ?? 8;
  const slice = items.slice(0, limit);
  if (slice.length === 0) {
    return 'CRM історія візитів: записів за останні ~2 місяці немає.';
  }

  const lines: string[] = ['CRM історія візитів (для планування тривалості запису):'];
  const durations: number[] = [];

  for (const visit of slice) {
    const dateLabel = formatVisitDate(visit.date);
    const services = visit.items
      .filter((i) => /service/i.test(i.type) || i.type === 'Service')
      .map((i) => i.name);
    const allNames =
      services.length > 0
        ? services.join(', ')
        : visit.items.map((i) => i.name).filter(Boolean).join(', ') || 'візит';
    const dur =
      visit.durationMin > 0 ? `${visit.durationMin} хв` : 'тривалість н/д';
    if (visit.durationMin > 0) durations.push(visit.durationMin);
    const master = visit.professionalName
      ? ` | майстер: ${visit.professionalName}`
      : '';
    lines.push(`- ${dateLabel} | ${dur} | ${allNames}${master}`);
  }

  if (durations.length > 0) {
    const avg = Math.round(
      durations.reduce((a, b) => a + b, 0) / durations.length,
    );
    const last = durations[0]!;
    lines.push(
      `Орієнтир: остання тривалість ${last} хв, середня з історії ~${avg} хв — враховуй при виборі слота (якщо клієнт бере ту саму/схожу послугу).`,
    );
  }

  return lines.join('\n');
}

function formatVisitDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso || 'дата?';
  return new Date(ms).toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export async function fetchClientCrmHistory(
  clientId: string,
  opts?: { limit?: number },
): Promise<{
  items: CrmVisitHistoryItem[];
  provider: CrmProviderName | null;
  crmBuyerId: string | null;
  text: string;
}> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client?.crmBuyerId) {
    // Try auto-link once if we have phone
    if (client?.phone) {
      const link = await linkClientToCrm(clientId, { upsert: false });
      if (!link.crmBuyerId) {
        return {
          items: [],
          provider: link.provider,
          crmBuyerId: null,
          text:
            link.message ??
            'Клієнт не привʼязаний до CRM. Спочатку збережи телефон (update_client_info) або привʼяжи в адмінці.',
        };
      }
    } else {
      return {
        items: [],
        provider: null,
        crmBuyerId: null,
        text: 'Немає телефону / CRM-привʼязки — історія візитів недоступна.',
      };
    }
  }

  const refreshed = await prisma.client.findUnique({ where: { id: clientId } });
  if (!refreshed?.crmBuyerId) {
    return {
      items: [],
      provider: null,
      crmBuyerId: null,
      text: 'Клієнт не привʼязаний до CRM.',
    };
  }

  const provider = await resolveLinkProvider(refreshed.crmProvider);
  const crm = getCrmAdapter(provider);
  if (!crm.fetchClientHistory) {
    return {
      items: [],
      provider,
      crmBuyerId: refreshed.crmBuyerId,
      text: `CRM ${provider} не віддає історію візитів.`,
    };
  }

  try {
    const items = await crm.fetchClientHistory(refreshed.crmBuyerId, {
      limit: opts?.limit ?? 15,
    });
    return {
      items,
      provider,
      crmBuyerId: refreshed.crmBuyerId,
      text: formatCrmHistoryForPrompt(items, { limit: opts?.limit ?? 8 }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, clientId, provider }, 'fetchClientHistory failed');
    return {
      items: [],
      provider,
      crmBuyerId: refreshed.crmBuyerId,
      text: `Не вдалося завантажити історію CRM: ${message.slice(0, 200)}`,
    };
  }
}
