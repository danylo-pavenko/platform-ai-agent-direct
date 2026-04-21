/**
 * crm-sync.ts
 *
 * Mirrors local Client / Order writes into the active CRM provider.
 *
 * Callers fire these asynchronously (await only the `.catch()`) so the
 * IG reply path is never blocked by CRM latency. All writes are gated
 * behind `CRM_WRITE_ENABLED` — until the shop's field mapping is
 * reviewed, the bot stays local-DB-only.
 *
 * Responsibilities:
 *   - Resolve / create the crmBuyerId link (client.crm_buyer_id).
 *   - Translate extracted `custom_fields` from local slugs to CRM uuids
 *     via the CrmFieldMapping table.
 *   - Stamp Order.keycrmOrderId on successful order mirror (idempotent).
 */

import pino from 'pino';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getCrmAdapter } from './crm/index.js';
import type {
  CrmClientInput,
  CrmOrderInput,
  CrmLeadInput,
} from './crm/index.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';
import { notifyCrmFallback } from './telegram-notify.js';

const log = pino({ name: 'crm-sync' });

// ── mirrorClientToCrm ──────────────────────────────────────────────────────

/**
 * Push the local client's contact + extracted custom-field snapshot
 * into the CRM. Safe to call on every `update_client_info` turn; the
 * CRM de-duplicates via crmBuyerId once populated.
 */
export async function mirrorClientToCrm(
  clientId: string,
  extractedCustomFields: Record<string, unknown> = {},
): Promise<void> {
  if (!config.CRM_WRITE_ENABLED) return;

  const crm = getCrmAdapter();
  if (!crm.upsertClient || !crm.findClient) {
    log.debug({ provider: crm.name }, 'CRM adapter has no client writes — skipping');
    return;
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    log.warn({ clientId }, 'Client not found for CRM mirror');
    return;
  }

  // KeyCRM requires full_name on buyer create. If we don't have even an
  // IG handle yet, there's nothing meaningful to push — try again later.
  const fullName = client.displayName
    ?? client.igFullName
    ?? (client.igUsername ? `@${client.igUsername}` : null);
  if (!fullName) {
    log.debug({ clientId }, 'No name yet — skipping CRM mirror');
    return;
  }

  // 1. Resolve (or defer creation of) crmBuyerId.
  //    Trust the local link if present, otherwise reach into the CRM
  //    by phone/email. IG-only match is handled by the later upsert
  //    creating a fresh buyer and closing the loop via crmBuyerId.
  let crmBuyerId: string | null = client.crmBuyerId;
  if (!crmBuyerId) {
    try {
      const match = await crm.findClient({
        phone: client.phone ?? undefined,
        email: client.email ?? undefined,
        instagramUsername: client.igUsername ?? undefined,
      });
      crmBuyerId = match?.crmBuyerId ?? null;
    } catch (err) {
      log.warn({ err, clientId }, 'findClient failed — proceeding to create');
    }
  }

  // 2. Translate extracted custom fields (buyer-scope only) local_key → CRM uuid.
  const customFields: Array<{ key: string; value: string }> = [];
  if (Object.keys(extractedCustomFields).length > 0) {
    const { byLocalKey } = await getActiveCrmFieldMappings();
    for (const [localKey, rawValue] of Object.entries(extractedCustomFields)) {
      const mapping = byLocalKey.get(localKey);
      if (!mapping || mapping.scope !== 'buyer') continue;
      if (rawValue === null || rawValue === undefined || rawValue === '') continue;
      customFields.push({
        key: mapping.crmFieldKey,
        value: typeof rawValue === 'string' ? rawValue : String(rawValue),
      });
    }
  }

  const input: CrmClientInput = {
    fullName,
    phone: client.phone ?? undefined,
    email: client.email ?? undefined,
    instagramUsername: client.igUsername ?? undefined,
    shipping:
      client.deliveryCity || client.deliveryNpBranch
        ? {
            city: client.deliveryCity ?? undefined,
            address: client.deliveryNpBranch ?? undefined,
          }
        : undefined,
    customFields: customFields.length > 0 ? customFields : undefined,
  };

  const result = await crm.upsertClient(crmBuyerId, input);

  // 3. Persist the link the first time we learn it (or if the CRM
  //    merged a duplicate and gave us a different id).
  if (client.crmBuyerId !== result.crmBuyerId) {
    await prisma.client.update({
      where: { id: clientId },
      data: { crmBuyerId: result.crmBuyerId },
    });
    log.info(
      { clientId, crmBuyerId: result.crmBuyerId, provider: crm.name },
      'Linked local client to CRM buyer',
    );
  } else {
    log.info(
      {
        clientId,
        crmBuyerId: result.crmBuyerId,
        customFieldsMirrored: customFields.length,
        provider: crm.name,
      },
      'Client mirrored to CRM',
    );
  }
}

// ── mirrorOrderToCrm ───────────────────────────────────────────────────────

/**
 * Push a local Order into the CRM. Idempotent: a second call is a no-op
 * once Order.keycrmOrderId is set. Ensures the buyer exists in the CRM
 * first (pre-mirror) so the CRM-side order record ties to the right buyer.
 */
export async function mirrorOrderToCrm(orderId: string): Promise<void> {
  if (!config.CRM_WRITE_ENABLED) return;

  const crm = getCrmAdapter();
  if (!crm.createOrder) {
    log.debug({ provider: crm.name }, 'CRM adapter has no order writes — skipping');
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { client: true },
  });
  if (!order) {
    log.warn({ orderId }, 'Order not found for CRM mirror');
    return;
  }

  if (order.keycrmOrderId) {
    log.debug(
      { orderId, keycrmOrderId: order.keycrmOrderId },
      'Order already mirrored — skipping',
    );
    return;
  }

  // Ensure the buyer is in the CRM first. If this fails, we still try
  // to create the order (KeyCRM will create/match a buyer from the
  // nested contacts), just without the crmBuyerId link on our side.
  await mirrorClientToCrm(order.clientId).catch((err) => {
    log.warn({ err, orderId }, 'Pre-order client mirror failed — continuing');
  });

  // Order.items is stored as Prisma JsonValue — coerce each entry to a
  // plain record, skipping anything that isn't an object. Defensive
  // because collect_order could in theory serialize an unexpected shape.
  const rawItems = Array.isArray(order.items) ? order.items : [];
  const items = rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const obj = raw as Record<string, unknown>;
    return [
      {
        name: typeof obj.name === 'string' && obj.name ? obj.name : 'Товар',
        variant: typeof obj.variant === 'string' ? obj.variant : undefined,
        price: typeof obj.price === 'number' ? obj.price : 0,
        qty: typeof obj.qty === 'number' ? obj.qty : 1,
      },
    ];
  });

  const input: CrmOrderInput = {
    crmBuyerId: order.client.crmBuyerId ?? undefined,
    buyer: {
      fullName: order.customerName,
      phone: order.phone,
    },
    items,
    note: order.note ?? undefined,
    paymentMethod: order.paymentMethod as 'card' | 'transfer' | 'cod',
    shipping: {
      city: order.city,
      npBranch: order.npBranch,
    },
  };

  let result: Awaited<ReturnType<NonNullable<typeof crm.createOrder>>>;
  try {
    result = await crm.createOrder(input);
  } catch (err) {
    const rawItems = Array.isArray(order.items) ? order.items : [];
    const itemsText = rawItems
      .map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const o = raw as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name : 'Товар';
        const variant = typeof o.variant === 'string' ? ` (${o.variant})` : '';
        const price = typeof o.price === 'number' ? o.price : 0;
        const qty = typeof o.qty === 'number' ? o.qty : 1;
        return `${name}${variant} × ${qty} — ${price} ₴`;
      })
      .filter((v): v is string => v !== null)
      .join('\n');
    notifyCrmFallback({
      kind: 'order',
      entityId: orderId,
      reason: err instanceof Error ? err.message : String(err),
      clientIgUserId: order.client.igUserId,
      snapshot: [
        { label: "Ім'я", value: order.customerName },
        { label: 'Телефон', value: order.phone },
        { label: 'Місто', value: order.city },
        { label: 'НП', value: order.npBranch },
        { label: 'Оплата', value: order.paymentMethod },
        { label: 'Нотатка', value: order.note },
        { label: 'Товари', value: itemsText || null },
      ],
    }).catch((e) => log.warn({ err: e, orderId }, 'CRM fallback notify failed'));
    throw err;
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { keycrmOrderId: result.crmOrderId },
  });

  log.info(
    { orderId, keycrmOrderId: result.crmOrderId, provider: crm.name },
    'Order mirrored to CRM',
  );
}

// ── mirrorBriefToCrm ───────────────────────────────────────────────────────

/**
 * Push a local PresaleBrief into the CRM as a pipeline card / lead.
 *
 * Idempotent: a second call is a no-op once PresaleBrief.keycrmLeadId is
 * set. Pre-mirrors the client (so the card ties to the right buyer) and
 * translates lead-scope custom fields from local slugs → CRM uuids.
 *
 * On any failure, the brief's `status` is flipped to `failed` so a
 * follow-up job / manager alert can retry. The customer flow never sees
 * this error — the Telegram notification already fired from the brief
 * handler before we were called.
 */
export async function mirrorBriefToCrm(briefId: string): Promise<void> {
  if (!config.CRM_WRITE_ENABLED) return;

  const crm = getCrmAdapter();
  if (!crm.createLead) {
    log.debug(
      { provider: crm.name, briefId },
      'CRM adapter has no lead writes — skipping',
    );
    return;
  }

  const brief = await prisma.presaleBrief.findUnique({
    where: { id: briefId },
    include: { client: true },
  });
  if (!brief) {
    log.warn({ briefId }, 'Brief not found for CRM mirror');
    return;
  }

  if (brief.keycrmLeadId) {
    log.debug(
      { briefId, keycrmLeadId: brief.keycrmLeadId },
      'Brief already mirrored — skipping',
    );
    return;
  }

  // Ensure the buyer is in the CRM first so the pipeline card can be
  // attached to a real client_id (not just a duplicated contact snapshot).
  await mirrorClientToCrm(brief.clientId).catch((err) => {
    log.warn({ err, briefId }, 'Pre-brief client mirror failed — continuing');
  });

  const client = await prisma.client.findUnique({ where: { id: brief.clientId } });

  // Translate lead-scope custom fields from the brief's raw payload
  // using the per-tenant CRM mapping.
  const customFields: Array<{ key: string; value: string }> = [];
  const rawPayload = (brief.rawPayload ?? {}) as Record<string, unknown>;
  const extractedCustomFields = (rawPayload.custom_fields ?? {}) as Record<string, unknown>;

  if (Object.keys(extractedCustomFields).length > 0) {
    const { byLocalKey } = await getActiveCrmFieldMappings();
    for (const [localKey, rawValue] of Object.entries(extractedCustomFields)) {
      const mapping = byLocalKey.get(localKey);
      if (!mapping || mapping.scope !== 'lead') continue;
      if (rawValue === null || rawValue === undefined || rawValue === '') continue;
      customFields.push({
        key: mapping.crmFieldKey,
        value: typeof rawValue === 'string' ? rawValue : String(rawValue),
      });
    }
  }

  // Build a short, human-readable manager comment from the structured
  // fields so the card is scannable without opening each custom field.
  const comment = buildBriefManagerComment(brief);

  // Title: keep it short — KeyCRM shows this in the kanban view.
  const titleParts: string[] = [];
  if (brief.businessName) titleParts.push(brief.businessName);
  else if (brief.niche) titleParts.push(brief.niche);
  if (brief.services && brief.services.length > 0) {
    titleParts.push(brief.services.slice(0, 2).join(' / '));
  }
  const title = titleParts.length > 0 ? titleParts.join(' — ') : undefined;

  // Contact snapshot: prefer real name/phone/email from the brief itself;
  // fall back to the client record so KeyCRM can still match / dedupe.
  const fullName =
    client?.displayName ??
    client?.igFullName ??
    (client?.igUsername ? `@${client.igUsername}` : undefined);

  const input: CrmLeadInput = {
    crmBuyerId: client?.crmBuyerId ?? undefined,
    title,
    managerComment: comment,
    contact: {
      fullName,
      phone: brief.phone ?? client?.phone ?? undefined,
      email: brief.email ?? client?.email ?? undefined,
    },
    customFields: customFields.length > 0 ? customFields : undefined,
  };

  try {
    const { crmLeadId } = await crm.createLead(input);
    await prisma.presaleBrief.update({
      where: { id: briefId },
      data: { keycrmLeadId: crmLeadId, status: 'synced' },
    });
    log.info(
      { briefId, crmLeadId, provider: crm.name, customFields: customFields.length },
      'Brief mirrored to CRM',
    );
  } catch (err) {
    await prisma.presaleBrief.update({
      where: { id: briefId },
      data: { status: 'failed' },
    });
    notifyCrmFallback({
      kind: 'brief',
      entityId: briefId,
      reason: err instanceof Error ? err.message : String(err),
      clientIgUserId: client?.igUserId ?? null,
      snapshot: [
        { label: 'Бізнес', value: brief.businessName },
        { label: 'Ніша', value: brief.niche },
        { label: 'Роль', value: brief.role },
        { label: 'Тип', value: brief.clientType },
        {
          label: 'Послуги',
          value: brief.services.length > 0 ? brief.services.join(', ') : null,
        },
        { label: 'Ціль', value: brief.goal },
        { label: 'Бажаний результат', value: brief.desiredResult },
        { label: 'KPI', value: brief.kpi },
        { label: 'Що вже робили', value: brief.currentActivity },
        { label: 'Попередні підрядники', value: brief.previousContractors },
        { label: 'Болі', value: brief.painPoints },
        { label: 'Розмір', value: brief.size },
        { label: 'Гео', value: brief.geo },
        { label: 'Сайт', value: brief.websiteUrl },
        { label: 'Instagram', value: brief.instagramUrl },
        { label: 'Інші канали', value: brief.otherChannels },
        { label: 'Бюджет', value: brief.budgetRange },
        { label: 'Період бюджету', value: brief.budgetPeriod },
        { label: 'Старт', value: brief.desiredStart },
        { label: 'Дедлайни', value: brief.deadlines },
        { label: 'Телефон', value: brief.phone ?? client?.phone },
        { label: 'Email', value: brief.email ?? client?.email },
        { label: 'Зручний канал', value: brief.preferredChannel },
        { label: 'Зручний час', value: brief.preferredTime },
        { label: 'Пріоритет', value: brief.priority },
        { label: 'Повнота', value: brief.completenessPct != null ? `${brief.completenessPct}%` : null },
      ],
    }).catch((e) => log.warn({ err: e, briefId }, 'CRM fallback notify failed'));
    throw err;
  }
}

/**
 * Renders the structured presale brief into a single manager-readable block
 * to drop into the KeyCRM card's "manager comment". The custom-field
 * mirror is the source of truth for structured data — this is just a
 * human-scannable overview on top.
 */
function buildBriefManagerComment(
  brief: { [k: string]: unknown } & {
    services: string[];
    niche: string | null;
    businessName: string | null;
    role: string | null;
    clientType: string | null;
    goal: string | null;
    desiredResult: string | null;
    kpi: string | null;
    currentActivity: string | null;
    previousContractors: string | null;
    painPoints: string | null;
    size: string | null;
    geo: string | null;
    websiteUrl: string | null;
    instagramUrl: string | null;
    otherChannels: string | null;
    budgetRange: string | null;
    budgetPeriod: string | null;
    desiredStart: string | null;
    deadlines: string | null;
    preferredChannel: string | null;
    preferredTime: string | null;
    priority: string | null;
  },
): string {
  const row = (label: string, value: string | null | undefined): string | null =>
    value && value.trim() ? `${label}: ${value.trim()}` : null;

  const lines: (string | null)[] = [
    row('Бізнес', brief.businessName),
    row('Ніша', brief.niche),
    row('Роль', brief.role),
    row('Тип', brief.clientType),
    brief.services.length > 0 ? `Послуги: ${brief.services.join(', ')}` : null,
    row('Ціль', brief.goal),
    row('Бажаний результат', brief.desiredResult),
    row('KPI', brief.kpi),
    row('Що вже робили', brief.currentActivity),
    row('Попередні підрядники', brief.previousContractors),
    row('Болі', brief.painPoints),
    row('Розмір', brief.size),
    row('Гео', brief.geo),
    row('Сайт', brief.websiteUrl),
    row('Instagram', brief.instagramUrl),
    row('Інші канали', brief.otherChannels),
    row('Бюджет', brief.budgetRange),
    row('Період бюджету', brief.budgetPeriod),
    row('Старт', brief.desiredStart),
    row('Дедлайни', brief.deadlines),
    row('Зручний канал', brief.preferredChannel),
    row('Зручний час', brief.preferredTime),
    row('Пріоритет', brief.priority),
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
}
