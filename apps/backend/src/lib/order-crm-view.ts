import {
  isCrmProviderName,
  providerDisplayName,
  type CrmProviderName,
} from './crm-providers.js';
import { parseAppointmentIdFromOrderNote } from './order-appointment.js';

export interface OrderCrmAppointment {
  id: string;
  crmProvider: string;
  crmRecordId: string | null;
  crmSyncStatus: string;
  crmSyncError: string | null;
  crmSyncedAt: Date | string | null;
  status?: string | null;
}

export interface OrderCrmSource {
  kind?: string | null;
  note?: string | null;
  status?: string | null;
  keycrmOrderId?: string | null;
  crmSyncStatus?: string | null;
  crmSyncError?: string | null;
  crmSyncedAt?: Date | string | null;
}

export interface OrderCrmView {
  kind: string;
  appointmentId: string | null;
  crmProvider: CrmProviderName | null;
  crmProviderLabel: string;
  crmRecordId: string | null;
  crmSyncStatus: string;
  crmSyncError: string | null;
  crmSyncedAt: Date | string | null;
  alreadyInCrm: boolean;
  canRetryCrm: boolean;
}

function asProvider(value: string | null | undefined): CrmProviderName | null {
  if (!value) return null;
  return isCrmProviderName(value) ? value : null;
}

export function buildOrderCrmView(
  order: OrderCrmSource,
  appointment?: OrderCrmAppointment | null,
): OrderCrmView {
  const kind = order.kind ?? 'product';
  const appointmentId =
    kind === 'booking' ? parseAppointmentIdFromOrderNote(order.note) : null;

  if (kind === 'booking') {
    const provider = asProvider(appointment?.crmProvider);
    const crmRecordId = appointment?.crmRecordId ?? null;
    const alreadyInCrm = Boolean(crmRecordId);
    const crmSyncStatus = alreadyInCrm
      ? 'synced'
      : (appointment?.crmSyncStatus ?? order.crmSyncStatus ?? 'skipped');
    const cancelled = order.status === 'cancelled' || appointment?.status === 'cancelled';

    return {
      kind,
      appointmentId,
      crmProvider: provider,
      crmProviderLabel: provider ? providerDisplayName(provider) : 'CRM',
      crmRecordId,
      crmSyncStatus,
      crmSyncError: alreadyInCrm ? null : (appointment?.crmSyncError ?? order.crmSyncError ?? null),
      crmSyncedAt: appointment?.crmSyncedAt ?? order.crmSyncedAt ?? null,
      alreadyInCrm,
      canRetryCrm: !alreadyInCrm && !cancelled,
    };
  }

  const crmRecordId = order.keycrmOrderId ?? null;
  const alreadyInCrm = Boolean(crmRecordId);
  const crmSyncStatus = alreadyInCrm
    ? 'synced'
    : (order.crmSyncStatus ?? 'pending');
  const cancelled = order.status === 'cancelled';

  return {
    kind,
    appointmentId: null,
    crmProvider: 'keycrm',
    crmProviderLabel: providerDisplayName('keycrm'),
    crmRecordId,
    crmSyncStatus,
    crmSyncError: alreadyInCrm ? null : (order.crmSyncError ?? null),
    crmSyncedAt: order.crmSyncedAt ?? null,
    alreadyInCrm,
    canRetryCrm: !alreadyInCrm && crmSyncStatus !== 'synced' && !cancelled,
  };
}
