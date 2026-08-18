import { describe, expect, it } from 'vitest';
import { buildOrderCrmView } from './order-crm-view.js';

describe('buildOrderCrmView', () => {
  it('overlays appointment CRM on a skipped booking order', () => {
    const view = buildOrderCrmView(
      {
        kind: 'booking',
        note: 'Запис\nappointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
        crmSyncStatus: 'skipped',
        keycrmOrderId: null,
      },
      {
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: 'bp-appt-1',
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: new Date('2026-08-18T10:00:00.000Z'),
      },
    );

    expect(view.crmSyncStatus).toBe('synced');
    expect(view.crmProviderLabel).toBe('BeautyPro');
    expect(view.crmRecordId).toBe('bp-appt-1');
    expect(view.canRetryCrm).toBe(false);
    expect(view.alreadyInCrm).toBe(true);
  });

  it('allows retry when booking was skipped and appointment is not in CRM', () => {
    const view = buildOrderCrmView(
      {
        kind: 'booking',
        note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
        crmSyncStatus: 'skipped',
      },
      {
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: null,
        crmSyncStatus: 'pending',
        crmSyncError: null,
        crmSyncedAt: null,
      },
    );

    expect(view.crmSyncStatus).toBe('pending');
    expect(view.canRetryCrm).toBe(true);
  });

  it('allows retry for skipped product orders without KeyCRM id', () => {
    const view = buildOrderCrmView({
      kind: 'product',
      crmSyncStatus: 'skipped',
      keycrmOrderId: null,
    });

    expect(view.canRetryCrm).toBe(true);
    expect(view.crmProviderLabel).toBe('KeyCRM');
  });

  it('does not retry cancelled bookings', () => {
    const view = buildOrderCrmView(
      {
        kind: 'booking',
        status: 'cancelled',
        note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
        crmSyncStatus: 'skipped',
      },
      {
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: null,
        crmSyncStatus: 'pending',
        crmSyncError: null,
        crmSyncedAt: null,
      },
    );
    expect(view.canRetryCrm).toBe(false);
  });

  it('surfaces appointment failure and still allows retry', () => {
    const view = buildOrderCrmView(
      {
        kind: 'booking',
        status: 'submitted',
        note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
        crmSyncStatus: 'skipped',
      },
      {
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'cleverbox',
        crmRecordId: null,
        crmSyncStatus: 'failed',
        crmSyncError: 'TIME_CONFLICT',
        crmSyncedAt: null,
      },
    );
    expect(view.crmSyncStatus).toBe('failed');
    expect(view.crmSyncError).toBe('TIME_CONFLICT');
    expect(view.crmProviderLabel).toBe('CleverBOX');
    expect(view.canRetryCrm).toBe(true);
  });

  it('does not retry cancelled product orders', () => {
    const view = buildOrderCrmView({
      kind: 'product',
      status: 'cancelled',
      crmSyncStatus: 'failed',
      keycrmOrderId: null,
    });
    expect(view.canRetryCrm).toBe(false);
  });
});
