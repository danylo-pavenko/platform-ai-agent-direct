/**
 * Link local Client ↔ CRM buyer/client id + fetch visit history for booking context.
 *
 * Auto-link runs when the client shares a phone (agent tool / heuristic / admin).
 * Manual attach is available from admin (POST crm-link with crmBuyerId).
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { getCrmForAction } from '../lib/crm-routing.js';
import { CRM_NOT_CONNECTED_LABEL, isCrmProviderName, type CrmProviderName } from '../lib/crm-providers.js';
import { getCrmAdapter } from './crm/index.js';
import type { CrmVisitHistoryItem } from './crm/types.js';
import {
  formatRecommendedDurationBlock,
  resolveRecommendedDuration,
} from '../lib/client-service-duration.js';

import { crmPersonFullName, effectiveClientPersonName, isPlausiblePersonName } from '../lib/client-person-name.js';
import { nameMatchMayAttachCard, normalizeUaPhone } from '../lib/client-contact-heuristics.js';

const log = pino({ name: 'client-crm-link' });

export interface LinkClientResult {
  linked: boolean;
  crmBuyerId: string | null;
  provider: CrmProviderName | null;
  source:
    | 'existing'
    | 'manual'
    | 'phone_match'
    | 'name_match'
    | 'upsert'
    | 'unlinked'
    | 'skipped';
  message?: string;
  /** CRM card name when found via findClient (BeautyPro etc.). */
  fullName?: string | null;
}

/**
 * Copy phone (and missing displayName) from CRM card onto local Client.
 * Never overwrites a local phone that already differs.
 */
export async function hydrateLocalClientFromCrm(
  clientId: string,
  opts?: {
    crmBuyerId?: string;
    provider?: CrmProviderName | string | null;
    fullName?: string | null;
    phone?: string | null;
  },
): Promise<{ phoneSynced: boolean; nameSynced: boolean }> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return { phoneSynced: false, nameSynced: false };

  const provider = await resolveLinkProvider(opts?.provider ?? client.crmProvider);
  if (!provider) return { phoneSynced: false, nameSynced: false };
  const crm = getCrmAdapter(provider);
  const crmBuyerId = (opts?.crmBuyerId ?? client.crmBuyerId)?.trim();

  let phone = opts?.phone?.trim() || null;
  let fullName = opts?.fullName?.trim() || null;

  if (crmBuyerId && (!phone || !fullName) && (crm.fetchClient || crm.findClient)) {
    try {
      const card =
        (crm.fetchClient ? await crm.fetchClient(crmBuyerId) : null) ??
        (crm.findClient ? await crm.findClient({ crmBuyerId }) : null);
      if (card) {
        if (!phone && card.phone?.trim()) phone = card.phone.trim();
        if (!fullName && card.fullName?.trim()) fullName = card.fullName.trim();
      }
    } catch (err) {
      log.warn({ err, clientId, crmBuyerId }, 'hydrateLocalClientFromCrm fetch failed');
    }
  }

  const data: {
    phone?: string;
    displayName?: string;
  } = {};

  const normalizedCrmPhone = phone ? normalizeUaPhone(phone) ?? phone : null;
  if (normalizedCrmPhone && !client.phone?.trim()) {
    data.phone = normalizedCrmPhone;
  }

  const localPerson = effectiveClientPersonName(client.displayName, client.igFullName);
  if (
    fullName &&
    isPlausiblePersonName(fullName) &&
    !localPerson
  ) {
    data.displayName = fullName;
  }

  if (Object.keys(data).length === 0) {
    return { phoneSynced: false, nameSynced: false };
  }

  await prisma.client.update({ where: { id: clientId }, data });
  log.info(
    {
      clientId,
      crmBuyerId,
      phoneSynced: Boolean(data.phone),
      nameSynced: Boolean(data.displayName),
    },
    'Hydrated local client from CRM card',
  );
  return {
    phoneSynced: Boolean(data.phone),
    nameSynced: Boolean(data.displayName),
  };
}

async function resolveLinkProvider(
  preferred?: string | null,
): Promise<CrmProviderName | null> {
  if (preferred && isCrmProviderName(preferred)) {
    const { getIntegrationConfig } = await import('../lib/integration-config.js');
    const { providerHasCredentials } = await import('../lib/crm-write.js');
    const cfg = await getIntegrationConfig();
    if (providerHasCredentials(preferred, cfg)) {
      const adapter = getCrmAdapter(preferred);
      if (adapter.findClient || adapter.fetchClientHistory) return preferred;
    }
  }
  // Prefer booking CRM for salon history, fall back to client_upsert
  const bookingBound = await getCrmForAction('booking');
  if (
    bookingBound &&
    (bookingBound.adapter.findClient || bookingBound.adapter.fetchClientHistory)
  ) {
    return bookingBound.provider;
  }
  const upsertBound = await getCrmForAction('client_upsert');
  return upsertBound?.provider ?? null;
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

  // Manual attach — validate UUID exists in CRM when adapter can fetch the card.
  if (typeof opts?.crmBuyerId === 'string' && opts.crmBuyerId.trim()) {
    const provider = await resolveLinkProvider(client.crmProvider);
    if (!provider) {
      return {
        linked: false,
        crmBuyerId: null,
        provider: null,
        source: 'skipped',
        message: CRM_NOT_CONNECTED_LABEL,
      };
    }
    const crmBuyerId = opts.crmBuyerId.trim();
    const crm = getCrmAdapter(provider);
    if (crm.fetchClient || crm.findClient) {
      try {
        const card =
          (crm.fetchClient ? await crm.fetchClient(crmBuyerId) : null) ??
          (crm.findClient ? await crm.findClient({ crmBuyerId }) : null);
        if (!card?.crmBuyerId) {
          return {
            linked: false,
            crmBuyerId: null,
            provider,
            source: 'skipped',
            message: 'CRM клієнта з таким UUID не знайдено — перевір id у BeautyPro',
          };
        }
        await prisma.client.update({
          where: { id: clientId },
          data: {
            crmBuyerId: card.crmBuyerId,
            crmProvider: provider,
            crmLinkedAt: new Date(),
          },
        });
        await hydrateLocalClientFromCrm(clientId, {
          crmBuyerId: card.crmBuyerId,
          provider,
          fullName: card.fullName,
          phone: card.phone,
        });
        log.info({ clientId, crmBuyerId: card.crmBuyerId, provider }, 'Manually linked client to CRM');
        return {
          linked: true,
          crmBuyerId: card.crmBuyerId,
          provider,
          source: 'manual',
          fullName: card.fullName ?? null,
        };
      } catch (err) {
        log.warn({ err, clientId, crmBuyerId, provider }, 'Manual CRM link validate failed');
        return {
          linked: false,
          crmBuyerId: null,
          provider,
          source: 'skipped',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    await prisma.client.update({
      where: { id: clientId },
      data: {
        crmBuyerId,
        crmProvider: provider,
        crmLinkedAt: new Date(),
      },
    });
    log.info({ clientId, crmBuyerId, provider }, 'Manually linked client to CRM (no fetchClient)');
    return {
      linked: true,
      crmBuyerId,
      provider,
      source: 'manual',
    };
  }

  if (client.crmBuyerId) {
    const provider = isCrmProviderName(client.crmProvider ?? '')
      ? (client.crmProvider as CrmProviderName)
      : await resolveLinkProvider(client.crmProvider);
    if (provider) {
      await hydrateLocalClientFromCrm(clientId, {
        crmBuyerId: client.crmBuyerId,
        provider,
      });
    }
    return {
      linked: true,
      crmBuyerId: client.crmBuyerId,
      provider,
      source: 'existing',
    };
  }

  const provider = await resolveLinkProvider(client.crmProvider);
  if (!provider) {
    return {
      linked: false,
      crmBuyerId: null,
      provider: null,
      source: 'skipped',
      message: CRM_NOT_CONNECTED_LABEL,
    };
  }
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

  const personName = effectiveClientPersonName(client.displayName, client.igFullName);

  if (!client.phone && !client.email && !personName) {
    return {
      linked: false,
      crmBuyerId: null,
      provider,
      source: 'skipped',
      message: 'Немає телефону, email або імені для пошуку в CRM',
    };
  }

  let matchedId: string | null = null;
  let matchedName: string | null = null;
  let matchedPhone: string | null = null;
  let matchSource: 'phone_match' | 'name_match' = 'phone_match';
  try {
    const match = await crm.findClient({
      phone: client.phone ?? undefined,
      email: client.email ?? undefined,
      name: personName ?? undefined,
      instagramUsername: client.igUsername ?? undefined,
    });
    matchedId = match?.crmBuyerId ?? null;
    matchedName =
      typeof match?.fullName === 'string' && match.fullName.trim()
        ? match.fullName.trim()
        : null;
    matchedPhone =
      typeof match?.phone === 'string' && match.phone.trim() ? match.phone.trim() : null;
    if (matchedId && !client.phone && !client.email && personName) {
      matchSource = 'name_match';
    }
    if (
      matchedId &&
      matchSource === 'name_match' &&
      !nameMatchMayAttachCard({
        localName: personName,
        cardName: matchedName,
        localPhone: client.phone,
        cardPhone: matchedPhone,
      })
    ) {
      log.info(
        { clientId, provider, personName, matchedName },
        'CRM name match is not the same person — not linking or copying the phone',
      );
      matchedId = null;
    }
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
    const localPerson = effectiveClientPersonName(client.displayName, client.igFullName);
    const adoptCrmName =
      matchedName &&
      isPlausiblePersonName(matchedName) &&
      !localPerson
        ? matchedName
        : undefined;
    const adoptPhone =
      matchedPhone && !client.phone?.trim()
        ? normalizeUaPhone(matchedPhone) ?? matchedPhone
        : undefined;
    await prisma.client.update({
      where: { id: clientId },
      data: {
        crmBuyerId: matchedId,
        crmProvider: provider,
        crmLinkedAt: new Date(),
        ...(adoptCrmName ? { displayName: adoptCrmName } : {}),
        ...(adoptPhone ? { phone: adoptPhone } : {}),
      },
    });
    if (!adoptPhone) {
      await hydrateLocalClientFromCrm(clientId, {
        crmBuyerId: matchedId,
        provider,
        fullName: matchedName,
        phone: matchedPhone,
      });
    }
    log.info(
      {
        clientId,
        crmBuyerId: matchedId,
        provider,
        adoptCrmName: Boolean(adoptCrmName),
        adoptPhone: Boolean(adoptPhone),
        matchSource,
      },
      'Linked client by CRM match',
    );
    return {
      linked: true,
      crmBuyerId: matchedId,
      provider,
      source: matchSource,
      fullName: matchedName,
    };
  }

  // Optional create in CRM (write path)
  const shouldUpsert = opts?.upsert !== false && (await isCrmWriteEnabled());
  if (shouldUpsert && crm.upsertClient) {
    const fullName = crmPersonFullName(client);
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
  if (client.crmBuyerId === crmBuyerId) {
    await hydrateLocalClientFromCrm(clientId, { crmBuyerId, provider });
    return;
  }

  await prisma.client.update({
    where: { id: clientId },
    data: {
      crmBuyerId,
      crmProvider: isCrmProviderName(provider) ? provider : provider,
      crmLinkedAt: new Date(),
    },
  });
  await hydrateLocalClientFromCrm(clientId, { crmBuyerId, provider });
  log.info({ clientId, crmBuyerId, provider }, 'Linked client from booking');
}

export function formatCrmHistoryForPrompt(
  items: CrmVisitHistoryItem[],
  opts?: {
    limit?: number;
    serviceId?: string;
    serviceName?: string;
    catalogDurationMin?: number;
    masterId?: string;
  },
): string {
  const limit = opts?.limit ?? 16;
  const slice = items.slice(0, limit);
  if (slice.length === 0) {
    return 'CRM історія візитів: записів за останні ~2 місяці немає.';
  }

  const lines: string[] = [
    'CRM історія візитів (тривалість + улюблений майстер для запису):',
  ];
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
    const effective =
      typeof visit.actualDurationMin === 'number' && visit.actualDurationMin > 0
        ? visit.actualDurationMin
        : visit.durationMin;
    const booked = visit.bookedDurationMin ?? visit.durationMin;
    let dur = 'тривалість н/д';
    if (effective > 0) {
      if (
        typeof visit.actualDurationMin === 'number' &&
        visit.actualDurationMin > 0 &&
        booked > 0 &&
        visit.actualDurationMin !== booked
      ) {
        dur = `${visit.actualDurationMin} хв actual (booked ${booked})`;
      } else if (typeof visit.actualDurationMin === 'number' && visit.actualDurationMin > 0) {
        dur = `${visit.actualDurationMin} хв actual`;
      } else {
        dur = `${effective} хв`;
      }
      durations.push(effective);
    }
    let master = '';
    if (visit.professionalName || visit.professionalId) {
      const name = visit.professionalName ?? 'майстер';
      const idPart = visit.professionalId
        ? ` [master_id=${visit.professionalId}]`
        : '';
      master = ` | майстер: ${name}${idPart}`;
    }
    lines.push(`- ${dateLabel} | ${dur} | ${allNames}${master}`);
  }

  if (durations.length > 0) {
    const avg = Math.round(
      durations.reduce((a, b) => a + b, 0) / durations.length,
    );
    const last = durations[0]!;
    lines.push(
      `Орієнтир: остання тривалість ${last} хв, середня з історії ~${avg} хв — платформа підставить персональну тривалість у get_available_slots / book_appointment для схожої послуги.`,
    );
  }

  const lastWithMaster = slice.find((v) => v.professionalId);
  if (lastWithMaster?.professionalId) {
    const label = lastWithMaster.professionalName ?? 'попередній майстер';
    const serviceHint =
      lastWithMaster.items
        ?.map((i) => i.name)
        .filter(Boolean)
        .slice(0, 2)
        .join(', ') || 'схожа послуга';
    lines.push(
      `Улюблений майстер (лише для схожої послуги: ${serviceHint}): ${label} [master_id=${lastWithMaster.professionalId}] — запропонуй його і виклич get_available_slots з цим master_id ТІЛЬКИ якщо нова послуга того ж напрямку. Інша категорія (напр. волосся vs манікюр) — НЕ підставляй цей master_id; слоти без нього або з майстром з get_available_slots саме для нової послуги. Два майстри з однаковим імʼям — завжди UUID з tool result, не імʼя. Клієнту показуй лише ім'я, не id.`,
    );
  }

  if (opts?.serviceId || opts?.serviceName) {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: opts.catalogDurationMin ?? 60,
      serviceId: opts.serviceId,
      serviceName: opts.serviceName,
      masterId: opts.masterId,
      visits: items,
    });
    lines.push(formatRecommendedDurationBlock(rec));
  }

  return lines.join('\n');
}

/**
 * Agent tool: search CRM by phone, link local Client, optionally adopt CRM name.
 * Read-only CRM match (no upsert create).
 */
export async function lookupClientByPhone(
  clientId: string,
  phoneRaw: string,
): Promise<{
  found: boolean;
  crmBuyerId: string | null;
  fullName: string | null;
  phone: string | null;
  text: string;
}> {
  const phone =
    normalizeUaPhone(phoneRaw) ??
    (phoneRaw.trim().replace(/\D/g, '').length >= 10 ? phoneRaw.trim() : null);
  if (!phone) {
    return {
      found: false,
      crmBuyerId: null,
      fullName: null,
      phone: null,
      text: '[lookup_client_by_phone] ПОМИЛКА: некоректний телефон. Попроси номер ще раз.',
    };
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    return {
      found: false,
      crmBuyerId: null,
      fullName: null,
      phone,
      text: '[lookup_client_by_phone] ПОМИЛКА: клієнта не знайдено локально.',
    };
  }

  if (!client.phone || client.phone !== phone) {
    await prisma.client.update({
      where: { id: clientId },
      data: { phone },
    });
  }

  const provider = await resolveLinkProvider(client.crmProvider);
  if (!provider) {
    return {
      found: false,
      crmBuyerId: client.crmBuyerId,
      fullName: effectiveClientPersonName(client.displayName, client.igFullName) ?? null,
      phone,
      text: `[lookup_client_by_phone] ${CRM_NOT_CONNECTED_LABEL}.`,
    };
  }
  const crm = getCrmAdapter(provider);
  if (!crm.findClient) {
    return {
      found: false,
      crmBuyerId: client.crmBuyerId,
      fullName: effectiveClientPersonName(client.displayName, client.igFullName) ?? null,
      phone,
      text: `[lookup_client_by_phone] ПОМИЛКА: CRM ${provider} не підтримує пошук клієнта.`,
    };
  }

  let match: { crmBuyerId: string; fullName?: string } | null = null;
  try {
    match = await crm.findClient({ phone });
  } catch (err) {
    log.warn({ err, clientId, phone }, 'lookupClientByPhone findClient failed');
    return {
      found: false,
      crmBuyerId: null,
      fullName: null,
      phone,
      text: '[lookup_client_by_phone] ПОМИЛКА: CRM тимчасово недоступна.',
    };
  }

  if (match?.crmBuyerId) {
    const crmName =
      typeof match.fullName === 'string' && isPlausiblePersonName(match.fullName)
        ? match.fullName.trim()
        : null;
    const localPerson = effectiveClientPersonName(client.displayName, client.igFullName);
    await prisma.client.update({
      where: { id: clientId },
      data: {
        phone,
        crmBuyerId: match.crmBuyerId,
        crmProvider: provider,
        crmLinkedAt: new Date(),
        ...(crmName && !localPerson ? { displayName: crmName } : {}),
      },
    });
    const name = crmName ?? localPerson ?? null;
    return {
      found: true,
      crmBuyerId: match.crmBuyerId,
      fullName: name,
      phone,
      text: [
        '[lookup_client_by_phone] РЕЗУЛЬТАТ: знайдено в CRM.',
        `Телефон: ${phone}`,
        name
          ? `Імʼя з CRM / профілю: ${name} — використай як customer_name у book_appointment; не питай імʼя знову.`
          : 'Імʼя в CRM не знайдено — якщо в блоці «Імʼя:» профілю є імʼя, використай його; інакше коротко спитай лише імʼя.',
        'Далі можна get_client_crm_history (за потреби) і book_appointment з цим телефоном.',
      ].join('\n'),
    };
  }

  const localName = effectiveClientPersonName(client.displayName, client.igFullName);
  return {
    found: false,
    crmBuyerId: null,
    fullName: localName ?? null,
    phone,
    text: [
      '[lookup_client_by_phone] РЕЗУЛЬТАТ: у CRM за цим телефоном не знайдено.',
      `Телефон збережено: ${phone}`,
      localName
        ? `Імʼя з Instagram / профілю: ${localName} — використай для book_appointment; не питай імʼя знову.`
        : 'Імʼя ще невідоме — коротко спитай лише як звертатись (одне слово), потім book_appointment.',
    ].join('\n'),
  };
}

/**
 * Compact CRM link hint for cold prompts (no full visit dump — use get_client_crm_history).
 */
export function formatCrmLinkHintForPrompt(opts: {
  crmBuyerId: string;
  preferredMasterId?: string | null;
  preferredMasterName?: string | null;
}): string {
  const lines = [
    'Повну історію візитів CRM бери через get_client_crm_history (не вигадуй минулі візити).',
  ];
  const masterId = opts.preferredMasterId?.trim();
  if (masterId) {
    const label = opts.preferredMasterName?.trim() || 'попередній майстер';
    lines.push(
      `Улюблений майстер: ${label} [master_id=${masterId}] — лише для схожої послуги з історії. Інша категорія — не підставляй цей id; get_available_slots без нього. Однакові імена — тільки UUID з tool. Клієнту лише імʼя.`,
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
  opts?: {
    limit?: number;
    serviceId?: string;
    serviceName?: string;
    catalogDurationMin?: number;
    masterId?: string;
  },
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
  if (!provider) {
    return {
      items: [],
      provider: null,
      crmBuyerId: refreshed.crmBuyerId,
      text: CRM_NOT_CONNECTED_LABEL,
    };
  }
  const crm = getCrmAdapter(provider);
  if (!crm.fetchClientHistory) {
    return {
      items: [],
      provider,
      crmBuyerId: refreshed.crmBuyerId,
      text: `CRM ${provider} не віддає історію візитів.`,
    };
  }

  await hydrateLocalClientFromCrm(clientId, {
    crmBuyerId: refreshed.crmBuyerId,
    provider,
  });

  try {
    const items = await crm.fetchClientHistory(refreshed.crmBuyerId, {
      limit: opts?.limit ?? 20,
    });
    let text = formatCrmHistoryForPrompt(items, {
      limit: opts?.limit ?? 16,
      serviceId: opts?.serviceId,
      serviceName: opts?.serviceName,
      catalogDurationMin: opts?.catalogDurationMin,
      masterId: opts?.masterId,
    });

    // Past /history ≠ open planned visits — append upcoming for cancel/reschedule context.
    if (crm.listClientUpcomingBookings) {
      try {
        const { isoRangeForUpcomingHorizon, isoDateToUaDate } = await import(
          '../lib/active-booking-resolve.js'
        );
        const { getAgentConfig } = await import('../lib/agent-config.js');
        const { UPCOMING_VISIT_HORIZON_DAYS } = await import('../lib/upcoming-visit.js');
        const agentCfg = await getAgentConfig();
        const range = isoRangeForUpcomingHorizon(
          new Date(),
          agentCfg.timezone,
          UPCOMING_VISIT_HORIZON_DAYS,
        );
        const upcoming = await crm.listClientUpcomingBookings(refreshed.crmBuyerId, range);
        if (upcoming.length > 0) {
          const lines = upcoming.slice(0, 8).map((b) => {
            const ua = isoDateToUaDate(b.date) ?? b.date;
            const svc =
              b.serviceNames && b.serviceNames.length > 0
                ? b.serviceNames.join(', ')
                : 'послуга';
            return `- ${ua} о ${b.time}: ${svc}`;
          });
          text +=
            '\n\nНайближчі відкриті записи CRM (planned/confirmed — для cancel/reschedule):\n' +
            lines.join('\n');
        } else if (items.length === 0) {
          text +=
            '\nВідкритих записів (planned/confirmed) на найближчі дні для цієї CRM-картки теж немає. ' +
            'Якщо клієнт наполягає, що запис є — уточни телефон або request_handoff.';
        }
      } catch (err) {
        log.warn({ err, clientId }, 'upcoming append for CRM history failed');
      }
    }

    return {
      items,
      provider,
      crmBuyerId: refreshed.crmBuyerId,
      text,
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
