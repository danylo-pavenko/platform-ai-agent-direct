/**
 * Admin / Insights product order create — works in handoff, never sends IG.
 */
import pino from 'pino';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { isCrmWriteEnabled, isCrmWriteReady } from '../lib/crm-write.js';
import { normalizeOrderItems, resolveQuotedTotal } from '../lib/order-normalize.js';
import { parseAppointmentIdFromOrderNote } from '../lib/order-appointment.js';
import type { PaymentMethod as PrismaPaymentMethod } from '../generated/prisma/client.js';
import { AppointmentUpdateError, cancelAppointmentById } from './appointment.js';
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
  /** Final total quoted to the customer (required for product orders). */
  quotedTotal: number;
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

  if (
    typeof input.quotedTotal !== 'number' ||
    !Number.isFinite(input.quotedTotal) ||
    input.quotedTotal < 0
  ) {
    return { ok: false, error: 'Потрібен quotedTotal ≥ 0', code: 'VALIDATION' };
  }

  const normalisedItems = normalizeOrderItems(input.items, 'Товар');
  const quotedTotal = resolveQuotedTotal(input.quotedTotal, normalisedItems);
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
        quotedTotal,
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
        quotedTotal,
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

export class OrderCancelError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'OrderCancelError';
  }
}

export type CancelAdminOrderResult = {
  ok: true;
  orderId: string;
  kind: string;
  appointmentId: string | null;
  crmCancelled: boolean;
  crmError: string | null;
  crmSkipped: boolean;
};

/**
 * Cancel a local Order from admin (product/service/… or booking).
 * Booking: local always; CRM only when cancelCrm=true.
 * Product: local status only (KeyCRM has no cancel API wired).
 */
export async function cancelAdminOrder(
  orderId: string,
  opts?: { reason?: string; cancelCrm?: boolean },
): Promise<CancelAdminOrderResult> {
  const id = orderId.trim();
  if (!id) throw new OrderCancelError('Потрібен order id', 400);

  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      note: true,
      conversationId: true,
    },
  });
  if (!order) throw new OrderCancelError('Замовлення не знайдено', 404);
  if (order.status === 'cancelled') {
    throw new OrderCancelError('Вже скасовано', 400);
  }

  const reason = opts?.reason?.trim() || 'Скасовано менеджером в адмінці';
  const cancelCrm = opts?.cancelCrm === true;
  const kind = order.kind ?? 'product';

  if (kind === 'booking') {
    const appointmentId = parseAppointmentIdFromOrderNote(order.note);
    if (!appointmentId) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          isArchived: true,
          archivedAt: new Date(),
          note: order.note
            ? `${order.note}\n[admin cancel] ${reason}`
            : `[admin cancel] ${reason}`,
        },
      });
      log.info({ orderId: order.id }, 'Booking order cancelled locally (no appointmentId)');
      return {
        ok: true,
        orderId: order.id,
        kind,
        appointmentId: null,
        crmCancelled: false,
        crmError: 'Немає повʼязаного appointmentId — скасовано лише локально',
        crmSkipped: !cancelCrm,
      };
    }

    try {
      const result = await cancelAppointmentById(appointmentId, { reason, cancelCrm });
      return {
        ok: true,
        orderId: order.id,
        kind,
        appointmentId: result.appointmentId,
        crmCancelled: result.crmCancelled,
        crmError: result.crmError,
        crmSkipped: result.crmSkipped,
      };
    } catch (err) {
      if (err instanceof AppointmentUpdateError) {
        throw new OrderCancelError(err.message, err.statusCode);
      }
      throw err;
    }
  }

  if (cancelCrm) {
    throw new OrderCancelError(
      'Скасування в KeyCRM з адмінки не підтримується — зніміть «Також у CRM» або скасуйте лише локально',
      400,
    );
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'cancelled',
      isArchived: true,
      archivedAt: new Date(),
      note: order.note
        ? `${order.note}\n[admin cancel] ${reason}`
        : `[admin cancel] ${reason}`,
    },
  });

  log.info({ orderId: order.id, kind }, 'Order cancelled from admin');

  return {
    ok: true,
    orderId: order.id,
    kind,
    appointmentId: null,
    crmCancelled: false,
    crmError: null,
    crmSkipped: true,
  };
}
