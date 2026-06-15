import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { sendText } from './instagram.js';
import { notifyOrder } from './telegram-notify.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { mirrorOrderToCrm } from './crm-sync.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';

const log = pino({ name: 'order' });

const VALID_PAYMENT_METHODS = ['card', 'transfer', 'cod'] as const;
type PaymentMethod = (typeof VALID_PAYMENT_METHODS)[number];

function toPaymentMethod(value: unknown): PaymentMethod {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (VALID_PAYMENT_METHODS.includes(v as PaymentMethod)) {
      return v as PaymentMethod;
    }
    if (/післяплат|налож|cod|готівк/.test(v)) return 'cod';
    if (/переказ|transfer|iban|реквізит/.test(v)) return 'transfer';
    if (/карт|card|wayfor|онлайн/.test(v)) return 'card';
  }
  return 'cod';
}

export interface CollectOrderOptions {
  /** When set, this text is sent to the client instead of the generic confirmation. */
  clientMessage?: string;
  /** Create the order but do not send an IG message (caller sends the summary). */
  skipClientMessage?: boolean;
}

/**
 * Handles the `collect_order` tool call from Claude.
 *
 * Creates the order in DB, confirms to the client via IG,
 * and notifies the manager group in Telegram.
 *
 * @returns order id when created, null when skipped (validation / duplicate).
 */
export async function handleCollectOrder(
  conversationId: string,
  clientId: string,
  clientIgUserId: string,
  args: Record<string, unknown>,
  options?: CollectOrderOptions,
): Promise<string | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { state: true },
  });
  if (conversation?.state !== 'bot') {
    log.info(
      { conversationId, state: conversation?.state ?? null },
      'collect_order skipped — conversation not in bot mode (manager may have taken over)',
    );
    return null;
  }

  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    log.error({ conversationId, args }, 'collect_order called without items — skipping');
    return null;
  }

  const items = rawItems as Array<{
    name: string;
    variant?: string;
    price: number;
    qty: number;
  }>;
  const customerName =
    typeof args.customer_name === 'string' ? args.customer_name.trim() : '';
  const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
  const city = typeof args.city === 'string' ? args.city.trim() : '';
  const npBranch = typeof args.np_branch === 'string' ? args.np_branch.trim() : '';

  if (!customerName || !phone || !city || !npBranch) {
    log.error(
      { conversationId, customerName: !!customerName, phone: !!phone, city: !!city, npBranch: !!npBranch },
      'collect_order missing required fields — skipping',
    );
    return null;
  }
  const paymentMethod = toPaymentMethod(args.payment_method);
  const note = (args.note as string) || null;

  // Normalise line items — Claude may omit name or send price/qty as strings.
  const normalisedItems = items.map((item) => ({
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Товар',
    variant:
      typeof item.variant === 'string' && item.variant.trim()
        ? item.variant.trim()
        : undefined,
    price: Number(item.price) || 0,
    qty: Number(item.qty) > 0 ? Number(item.qty) : 1,
  }));

  const crmWrites = await isCrmWriteEnabled();

  const existing = await prisma.order.findFirst({
    where: {
      conversationId,
      status: { notIn: ['draft', 'cancelled'] },
    },
    select: { id: true },
  });
  if (existing) {
    log.info({ conversationId, orderId: existing.id }, 'Order already exists for conversation — skipping duplicate');
    return existing.id;
  }

  // 1. Create order in DB
  const order = await prisma.order.create({
    data: {
      conversationId,
      clientId,
      items: normalisedItems as any,
      customerName,
      phone,
      city,
      npBranch,
      paymentMethod,
      note,
      status: 'submitted',
      submittedToManagerAt: new Date(),
      crmSyncStatus: crmWrites ? 'pending' : 'skipped',
    },
  });

  // 2. Send confirmation to client via Instagram (unless caller sends the summary)
  const confirmationText =
    options?.clientMessage?.trim() ||
    'Замовлення прийнято! Менеджер підтвердить і напише Вам найближчим часом.';

  if (!options?.skipClientMessage) {
    await sendText(clientIgUserId, confirmationText);

    // 3. Persist the bot confirmation message
    await prisma.message.create({
      data: {
        conversationId,
        direction: 'out',
        sender: 'bot',
        text: confirmationText,
      },
    });
    markFirstOutboundAt(conversationId).catch((err) =>
      log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
    );
  }

  // 4. Telegram card for managers — fire-and-forget (same as brief/handoff).
  notifyOrder({
    orderId: order.id,
    conversationId,
    clientIgUserId,
    items: normalisedItems,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
  }).catch((err) => {
    log.error({ err, orderId: order.id, conversationId }, 'Failed to send order Telegram notification');
  });

  // 5. Mirror into CRM asynchronously — manager group has already
  // been notified locally, so a CRM outage must not delay or fail
  // the customer flow. No-op when CRM_WRITE_ENABLED=false.
  mirrorOrderToCrm(order.id).catch((err) => {
    log.error({ err, orderId: order.id }, 'Failed to mirror order to CRM');
  });

  log.info(
    { orderId: order.id, conversationId, itemCount: normalisedItems.length },
    'Order created and notifications sent',
  );

  return order.id;
}
