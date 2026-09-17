/**
 * Admin / Insights product order create — works in handoff, never sends IG.
 */
import pino from 'pino';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { isCrmWriteEnabled, isCrmWriteReady } from '../lib/crm-write.js';
import { normalizeOrderItems } from '../lib/order-normalize.js';
import type { PaymentMethod as PrismaPaymentMethod } from '../generated/prisma/client.js';
import { mirrorOrderToCrm } from './crm-sync.js';
import { notifyOrder } from './telegram-notify.js';

const log = pino({ name: 'order-admin' });

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

export interface AdminProductOrderInput {
  conversationId: string;
  items: unknown;
  customerName: string;
  phone: string;
  city: string;
  npBranch: string;
  paymentMethod?: unknown;
  note?: string | null;
  /** Create even if an active product order already exists. */
  force?: boolean;
  /** Default true when CRM write is ready. */
  mirrorCrm?: boolean;
  /** Notify manager Telegram (default true). */
  notifyTelegram?: boolean;
}

export type AdminProductOrderResult =
  | {
      ok: true;
      orderId: string;
      alreadyExisted: boolean;
      crmSyncStatus: string;
      keycrmOrderId: string | null;
      crmSyncError: string | null;
      conversationId: string;
      path: string;
    }
  | {
      ok: false;
      error: string;
      code:
        | 'NOT_FOUND'
        | 'CANCELLED'
        | 'VALIDATION'
        | 'DUPLICATE'
        | 'CREATE_FAILED';
    };

/**
 * Create a local product Order from admin Insights (or similar).
 * Does not require conversation.state === 'bot' and never messages the client on IG.
 */
export async function createAdminProductOrder(
  input: AdminProductOrderInput,
): Promise<AdminProductOrderResult> {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    return { ok: false, error: 'Потрібен conversationId', code: 'VALIDATION' };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      state: true,
      clientId: true,
      client: { select: { igUserId: true } },
    },
  });
  if (!conversation) {
    return { ok: false, error: 'Діалог не знайдено', code: 'NOT_FOUND' };
  }
  if (conversation.state === 'closed') {
    return { ok: false, error: 'Закритий діалог — замовлення не створюється', code: 'CANCELLED' };
  }

  const customerName = input.customerName.trim();
  const phone = input.phone.trim();
  const city = input.city.trim();
  const npBranch = input.npBranch.trim();
  if (!customerName || !phone || !city || !npBranch) {
    return {
      ok: false,
      error: 'Потрібні customerName, phone, city, npBranch',
      code: 'VALIDATION',
    };
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: 'Потрібен непорожній items[]', code: 'VALIDATION' };
  }

  const normalisedItems = normalizeOrderItems(input.items, 'Товар');
  const paymentMethod = toPaymentMethod(input.paymentMethod);
  const note = input.note?.trim() || null;

  const existing = await prisma.order.findFirst({
    where: {
      conversationId,
      isArchived: false,
      status: { notIn: ['draft', 'cancelled'] },
      kind: 'product',
    },
    select: {
      id: true,
      crmSyncStatus: true,
      keycrmOrderId: true,
      crmSyncError: true,
    },
  });

  if (existing && !input.force) {
    return {
      ok: false,
      error: `У діалозі вже є замовлення ${existing.id}. Передай force=true щоб створити ще одне, або retry_order_crm_sync.`,
      code: 'DUPLICATE',
    };
  }

  const wantMirror = input.mirrorCrm !== false;
  const writeReady = wantMirror ? await isCrmWriteReady('order') : { ready: false };
  const crmWrites = wantMirror && writeReady.ready && (await isCrmWriteEnabled());

  let order;
  try {
    order = await prisma.order.create({
      data: {
        conversationId,
        clientId: conversation.clientId,
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
  } catch (err) {
    log.error({ err, conversationId }, 'createAdminProductOrder failed');
    return { ok: false, error: 'Не вдалося створити замовлення', code: 'CREATE_FAILED' };
  }

  if (input.notifyTelegram !== false) {
    const igUserId = conversation.client.igUserId;
    if (igUserId) {
      notifyOrder({
        orderId: order.id,
        conversationId,
        clientIgUserId: igUserId,
        kind: 'product',
        summary: null,
        items: normalisedItems,
        customerName,
        phone,
        city,
        npBranch,
        paymentMethod,
      }).catch((err) => {
        log.error({ err, orderId: order.id }, 'Admin order Telegram notify failed');
      });
    }
  }

  if (crmWrites) {
    try {
      await mirrorOrderToCrm(order.id, { force: true });
    } catch (err) {
      log.error({ err, orderId: order.id }, 'Admin order CRM mirror failed');
    }
  }

  const updated = await prisma.order.findUnique({
    where: { id: order.id },
    select: {
      id: true,
      crmSyncStatus: true,
      keycrmOrderId: true,
      crmSyncError: true,
    },
  });

  log.info(
    {
      orderId: order.id,
      conversationId,
      crmSyncStatus: updated?.crmSyncStatus,
      keycrmOrderId: updated?.keycrmOrderId,
    },
    'Admin product order created',
  );

  return {
    ok: true,
    orderId: order.id,
    alreadyExisted: false,
    crmSyncStatus: updated?.crmSyncStatus ?? order.crmSyncStatus,
    keycrmOrderId: updated?.keycrmOrderId ?? null,
    crmSyncError: updated?.crmSyncError ?? null,
    conversationId,
    path: `/conversations/${conversationId}`,
  };
}
