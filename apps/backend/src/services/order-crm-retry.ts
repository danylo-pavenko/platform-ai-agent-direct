import { prisma } from '../lib/prisma.js';
import { isCrmWriteReady } from '../lib/crm-write.js';
import { parseAppointmentIdFromOrderNote } from '../lib/order-appointment.js';
import {
  isCrmProviderName,
  providerDisplayName,
  type CrmProviderName,
} from '../lib/crm-providers.js';
import { mirrorOrderToCrm } from './crm-sync.js';
import { mirrorAppointmentToCrm, reflectAppointmentCrmOnOrder } from './appointment.js';

export class OrderCrmRetryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderCrmRetryError';
  }
}

export interface OrderCrmRetryResult {
  ok: true;
  alreadySynced: boolean;
  kind: string;
  crmProvider: CrmProviderName | string | null;
  crmRecordId: string | null;
  crmSyncStatus: string;
  crmSyncedAt: string | null;
  crmSyncError: string | null;
}

async function retryBookingCrmSync(order: {
  id: string;
  note: string | null;
  status: string;
}): Promise<OrderCrmRetryResult> {
  const appointmentId = parseAppointmentIdFromOrderNote(order.note);
  if (!appointmentId) {
    throw new OrderCrmRetryError(
      'Немає пов’язаного запису (appointmentId) — CRM для запису живе на Appointment',
      400,
    );
  }

  if (order.status === 'cancelled') {
    throw new OrderCrmRetryError('Скасоване замовлення не відвантажується в CRM', 400);
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      status: true,
      crmProvider: true,
      crmRecordId: true,
      crmSyncStatus: true,
      crmSyncError: true,
      crmSyncedAt: true,
    },
  });

  if (!appointment) {
    throw new OrderCrmRetryError('Пов’язаний запис не знайдено', 404);
  }

  if (appointment.status === 'cancelled') {
    throw new OrderCrmRetryError('Скасований запис не відвантажується в CRM', 400);
  }

  if (appointment.crmRecordId) {
    await reflectAppointmentCrmOnOrder(appointment);
    return {
      ok: true,
      alreadySynced: true,
      kind: 'booking',
      crmProvider: appointment.crmProvider,
      crmRecordId: appointment.crmRecordId,
      crmSyncStatus: 'synced',
      crmSyncedAt: appointment.crmSyncedAt?.toISOString() ?? null,
      crmSyncError: null,
    };
  }

  const writeReady = await isCrmWriteReady('booking');
  if (!writeReady.ready) {
    throw new OrderCrmRetryError(
      writeReady.reason ?? 'CRM write not available',
      400,
      { crmWrite: writeReady },
    );
  }

  await mirrorAppointmentToCrm(appointment.id, { force: true });

  const updated = await prisma.appointment.findUnique({
    where: { id: appointment.id },
    select: {
      id: true,
      crmProvider: true,
      crmRecordId: true,
      crmSyncStatus: true,
      crmSyncError: true,
      crmSyncedAt: true,
    },
  });

  if (updated) {
    await reflectAppointmentCrmOnOrder(updated);
  }

  if (updated?.crmSyncStatus !== 'synced' || !updated.crmRecordId) {
    throw new OrderCrmRetryError(
      updated?.crmSyncError ?? 'Не вдалося відвантажити запис у CRM',
      502,
      { crmSyncStatus: updated?.crmSyncStatus },
    );
  }

  return {
    ok: true,
    alreadySynced: false,
    kind: 'booking',
    crmProvider: updated.crmProvider,
    crmRecordId: updated.crmRecordId,
    crmSyncStatus: updated.crmSyncStatus,
    crmSyncedAt: updated.crmSyncedAt?.toISOString() ?? null,
    crmSyncError: null,
  };
}

async function retryProductCrmSync(order: {
  id: string;
  status: string;
  keycrmOrderId: string | null;
}): Promise<OrderCrmRetryResult> {
  if (order.status === 'cancelled') {
    throw new OrderCrmRetryError('Скасоване замовлення не відвантажується в CRM', 400);
  }

  if (order.keycrmOrderId) {
    return {
      ok: true,
      alreadySynced: true,
      kind: 'product',
      crmProvider: 'keycrm',
      crmRecordId: order.keycrmOrderId,
      crmSyncStatus: 'synced',
      crmSyncedAt: null,
      crmSyncError: null,
    };
  }

  const writeReady = await isCrmWriteReady('order');
  if (!writeReady.ready) {
    throw new OrderCrmRetryError(
      writeReady.reason ?? 'CRM write not available',
      400,
      { crmWrite: writeReady },
    );
  }

  await mirrorOrderToCrm(order.id, { force: true });

  const updated = await prisma.order.findUnique({
    where: { id: order.id },
    select: {
      keycrmOrderId: true,
      crmSyncStatus: true,
      crmSyncError: true,
      crmSyncedAt: true,
    },
  });

  if (updated?.crmSyncStatus !== 'synced' || !updated.keycrmOrderId) {
    throw new OrderCrmRetryError(
      updated?.crmSyncError ?? 'Не вдалося відвантажити замовлення у CRM',
      502,
      { crmSyncStatus: updated?.crmSyncStatus },
    );
  }

  return {
    ok: true,
    alreadySynced: false,
    kind: 'product',
    crmProvider: writeReady.provider ?? 'keycrm',
    crmRecordId: updated.keycrmOrderId,
    crmSyncStatus: updated.crmSyncStatus,
    crmSyncedAt: updated.crmSyncedAt?.toISOString() ?? null,
    crmSyncError: null,
  };
}

/**
 * Manual admin retry: product orders → KeyCRM createOrder;
 * booking orders → Appointment createBooking (BeautyPro / CleverBOX).
 */
export async function retryOrderCrmSync(orderId: string): Promise<OrderCrmRetryResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      kind: true,
      status: true,
      note: true,
      keycrmOrderId: true,
    },
  });

  if (!order) {
    throw new OrderCrmRetryError('Order not found', 404);
  }

  if (order.kind === 'booking') {
    return retryBookingCrmSync(order);
  }

  return retryProductCrmSync(order);
}

export function crmRetrySuccessMessage(result: OrderCrmRetryResult): string {
  const label =
    result.crmProvider && isCrmProviderName(result.crmProvider)
      ? providerDisplayName(result.crmProvider)
      : 'CRM';
  if (result.alreadySynced) {
    return result.kind === 'booking'
      ? `Запис уже в ${label}`
      : `Замовлення вже в ${label}`;
  }
  if (result.crmRecordId) {
    return result.kind === 'booking'
      ? `Запис відвантажено в ${label}`
      : `Синхронізовано: ${label} #${result.crmRecordId}`;
  }
  return 'Синхронізацію виконано';
}
