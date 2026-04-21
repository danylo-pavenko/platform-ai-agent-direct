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
import type { CrmClientInput, CrmOrderInput } from './crm/index.js';
import { getActiveCrmFieldMappings } from '../lib/crm-field-mappings.js';

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

  const result = await crm.createOrder(input);

  await prisma.order.update({
    where: { id: orderId },
    data: { keycrmOrderId: result.crmOrderId },
  });

  log.info(
    { orderId, keycrmOrderId: result.crmOrderId, provider: crm.name },
    'Order mirrored to CRM',
  );
}
