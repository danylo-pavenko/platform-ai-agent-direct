import pino from 'pino';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { sendText } from './instagram.js';
import { notifyOrder } from './telegram-notify.js';
import { isCrmWriteEnabled } from '../lib/crm-write.js';
import { mirrorOrderToCrm } from './crm-sync.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  normalizeOrderItems,
  parseOrderKind,
} from '../lib/order-normalize.js';
import type { OrderKind, PaymentMethod as PrismaPaymentMethod } from '../generated/prisma/client.js';

export { normalizeOrderItems, parseOrderKind, type LocalOrderKind } from '../lib/order-normalize.js';

const log = pino({ name: 'order' });

const VALID_PAYMENT_METHODS = ['card', 'transfer', 'cod'] as const;
type PaymentMethod = (typeof VALID_PAYMENT_METHODS)[number];

const LOCAL_ORDER_DEDUPE_MS = 2 * 60 * 1000;

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

function toOptionalPaymentMethod(value: unknown): PaymentMethod | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return toPaymentMethod(value);
}

export interface CollectOrderOptions {
  /** When set, this text is sent to the client instead of the generic confirmation. */
  clientMessage?: string;
  /** Create the order but do not send an IG message (caller sends the summary). */
  skipClientMessage?: boolean;
}

export interface CreateLocalOrderOptions {
  clientMessage?: string;
  skipClientMessage?: boolean;
  /** Fallbacks from Client profile when tool args omit contact fields. */
  clientDisplayName?: string | null;
  clientPhone?: string | null;
  clientIgUsername?: string | null;
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

  const normalisedItems = normalizeOrderItems(rawItems, 'Товар');

  const crmWrites = await isCrmWriteEnabled();

  const existing = await prisma.order.findFirst({
    where: {
      conversationId,
      isArchived: false,
      status: { notIn: ['draft', 'cancelled'] },
      kind: 'product',
    },
    select: { id: true },
  });
  if (existing) {
    log.info({ conversationId, orderId: existing.id }, 'Order already exists for conversation — skipping duplicate');
    return existing.id;
  }

  const order = await prisma.order.create({
    data: {
      conversationId,
      clientId,
      kind: 'product',
      items: toInputJsonValue(normalisedItems)!,
      customerName,
      phone,
      city,
      npBranch,
      paymentMethod: paymentMethod as PrismaPaymentMethod,
      note,
      status: 'submitted',
      submittedToManagerAt: new Date(),
      crmSyncStatus: crmWrites ? 'pending' : 'skipped',
    },
  });

  const confirmationText =
    options?.clientMessage?.trim() ||
    'Замовлення прийнято! Менеджер підтвердить і напише Вам найближчим часом.';

  if (!options?.skipClientMessage) {
    await sendText(clientIgUserId, confirmationText);

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

  notifyOrder({
    orderId: order.id,
    conversationId,
    clientIgUserId,
    kind: 'product',
    summary: null,
    items: normalisedItems,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
  }).catch((err) => {
    log.error({ err, orderId: order.id, conversationId }, 'Failed to send order Telegram notification');
  });

  mirrorOrderToCrm(order.id).catch((err) => {
    log.error({ err, orderId: order.id }, 'Failed to mirror order to CRM');
  });

  log.info(
    { orderId: order.id, conversationId, itemCount: normalisedItems.length },
    'Order created and notifications sent',
  );

  return order.id;
}

/**
 * Soft local order when the client agreed to a product, service, or callback.
 * Always local DB + Telegram; CRM mirror is skipped (incomplete fields).
 */
export async function handleCreateLocalOrder(
  conversationId: string,
  clientId: string,
  clientIgUserId: string,
  args: Record<string, unknown>,
  options?: CreateLocalOrderOptions,
): Promise<string | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { state: true },
  });
  if (conversation?.state !== 'bot') {
    log.info(
      { conversationId, state: conversation?.state ?? null },
      'create_local_order skipped — conversation not in bot mode',
    );
    return null;
  }

  const kind = parseOrderKind(args.kind);
  const summary =
    typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!kind || !summary) {
    log.error(
      { conversationId, kind, hasSummary: !!summary },
      'create_local_order missing kind/summary — skipping',
    );
    return null;
  }

  const preferredTime =
    typeof args.preferred_time === 'string' ? args.preferred_time.trim() : '';
  const noteParts: string[] = [];
  if (typeof args.note === 'string' && args.note.trim()) {
    noteParts.push(args.note.trim());
  }
  if (preferredTime) {
    noteParts.push(`Зручний час: ${preferredTime}`);
  }
  noteParts.push(`Угода: ${summary}`);
  const note = noteParts.join('\n');

  const customerName =
    (typeof args.customer_name === 'string' && args.customer_name.trim()) ||
    options?.clientDisplayName?.trim() ||
    (options?.clientIgUsername ? `@${options.clientIgUsername}` : '') ||
    'Клієнт IG';

  const phone =
    (typeof args.phone === 'string' && args.phone.trim()) ||
    options?.clientPhone?.trim() ||
    'не вказано';

  const city =
    typeof args.city === 'string' && args.city.trim() ? args.city.trim() : null;
  const npBranch =
    typeof args.np_branch === 'string' && args.np_branch.trim()
      ? args.np_branch.trim()
      : null;
  const paymentMethod = toOptionalPaymentMethod(args.payment_method);

  const normalisedItems = normalizeOrderItems(args.items, summary);

  const since = new Date(Date.now() - LOCAL_ORDER_DEDUPE_MS);
  const recent = await prisma.order.findFirst({
    where: {
      conversationId,
      kind: kind as OrderKind,
      isArchived: false,
      status: { notIn: ['cancelled'] },
      createdAt: { gte: since },
      note: { contains: summary.slice(0, 120) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (recent) {
    log.info(
      { conversationId, orderId: recent.id, kind },
      'create_local_order deduped — recent matching order',
    );
    return recent.id;
  }

  const order = await prisma.order.create({
    data: {
      conversationId,
      clientId,
      kind: kind as OrderKind,
      items: toInputJsonValue(normalisedItems)!,
      customerName,
      phone,
      city,
      npBranch,
      paymentMethod: paymentMethod as PrismaPaymentMethod | null,
      note,
      status: 'submitted',
      submittedToManagerAt: new Date(),
      crmSyncStatus: 'skipped',
    },
  });

  const confirmationText =
    options?.clientMessage?.trim() ||
    (kind === 'callback'
      ? 'Дякуємо! Передаємо менеджеру — передзвонять найближчим часом.'
      : 'Дякуємо! Заявку прийнято — менеджер напише Вам найближчим часом.');

  if (!options?.skipClientMessage) {
    await sendText(clientIgUserId, confirmationText);
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

  notifyOrder({
    orderId: order.id,
    conversationId,
    clientIgUserId,
    kind,
    summary,
    items: normalisedItems,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
  }).catch((err) => {
    log.error(
      { err, orderId: order.id, conversationId },
      'Failed to send local-order Telegram notification',
    );
  });

  log.info(
    { orderId: order.id, conversationId, kind, summary: summary.slice(0, 80) },
    'Local agreement order created (CRM skipped)',
  );

  return order.id;
}
