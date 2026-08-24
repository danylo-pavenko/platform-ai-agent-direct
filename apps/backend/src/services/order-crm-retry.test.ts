import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  isCrmWriteReady,
  mirrorOrderToCrm,
  mirrorAppointmentToCrm,
  reflectAppointmentCrmOnOrder,
} = vi.hoisted(() => ({
  prismaMock: {
    order: { findUnique: vi.fn() },
    appointment: { findUnique: vi.fn() },
  },
  isCrmWriteReady: vi.fn(),
  mirrorOrderToCrm: vi.fn(),
  mirrorAppointmentToCrm: vi.fn(),
  reflectAppointmentCrmOnOrder: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/crm-write.js', () => ({ isCrmWriteReady }));
vi.mock('./crm-sync.js', () => ({ mirrorOrderToCrm }));
vi.mock('./appointment.js', () => ({
  mirrorAppointmentToCrm,
  reflectAppointmentCrmOnOrder,
}));

import { OrderCrmRetryError, crmRetrySuccessMessage, retryOrderCrmSync } from './order-crm-retry.js';

describe('retryOrderCrmSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mirrors booking orders via Appointment, not KeyCRM createOrder', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique
      .mockResolvedValueOnce({
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        status: 'confirmed',
        crmProvider: 'beautypro',
        crmRecordId: null,
        crmSyncStatus: 'pending',
        crmSyncError: null,
        crmSyncedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: 'bp-1',
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: new Date('2026-08-18T10:00:00.000Z'),
      });
    isCrmWriteReady.mockResolvedValue({ ready: true, enabled: true, source: 'settings', provider: 'beautypro' });
    mirrorAppointmentToCrm.mockResolvedValue(undefined);
    reflectAppointmentCrmOnOrder.mockResolvedValue(undefined);

    const result = await retryOrderCrmSync('order-1');

    expect(isCrmWriteReady).toHaveBeenCalledWith('booking');
    expect(mirrorAppointmentToCrm).toHaveBeenCalledWith(
      'a0712020-04d1-4863-8ad4-1370d6905921',
      { force: true, forceTimeConflict: true },
    );
    expect(mirrorOrderToCrm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      kind: 'booking',
      crmRecordId: 'bp-1',
      crmProvider: 'beautypro',
    });
  });

  it('returns alreadySynced when appointment already has crmRecordId', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique.mockResolvedValue({
      id: 'a0712020-04d1-4863-8ad4-1370d6905921',
      status: 'synced',
      crmProvider: 'beautypro',
      crmRecordId: 'existing',
      crmSyncStatus: 'synced',
      crmSyncError: null,
      crmSyncedAt: new Date(),
    });

    const result = await retryOrderCrmSync('order-1');

    expect(result.alreadySynced).toBe(true);
    expect(mirrorAppointmentToCrm).not.toHaveBeenCalled();
    expect(reflectAppointmentCrmOnOrder).toHaveBeenCalled();
  });

  it('mirrors product orders through KeyCRM path', async () => {
    prismaMock.order.findUnique
      .mockResolvedValueOnce({
        id: 'order-2',
        kind: 'product',
        status: 'submitted',
        note: null,
        keycrmOrderId: null,
      })
      .mockResolvedValueOnce({
        keycrmOrderId: '999',
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: new Date(),
      });
    isCrmWriteReady.mockResolvedValue({ ready: true, enabled: true, source: 'env', provider: 'keycrm' });
    mirrorOrderToCrm.mockResolvedValue(undefined);

    const result = await retryOrderCrmSync('order-2');

    expect(isCrmWriteReady).toHaveBeenCalledWith('order');
    expect(mirrorOrderToCrm).toHaveBeenCalledWith('order-2', { force: true });
    expect(mirrorAppointmentToCrm).not.toHaveBeenCalled();
    expect(result.crmRecordId).toBe('999');
  });

  it('rejects booking retry when CRM writes are not ready', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique.mockResolvedValue({
      id: 'a0712020-04d1-4863-8ad4-1370d6905921',
      status: 'confirmed',
      crmProvider: 'beautypro',
      crmRecordId: null,
      crmSyncStatus: 'skipped',
      crmSyncError: null,
      crmSyncedAt: null,
    });
    isCrmWriteReady.mockResolvedValue({
      ready: false,
      enabled: true,
      source: 'settings',
      provider: 'beautypro',
      reason: 'BeautyPro очікує Grant access у Marketplace',
    });

    await expect(retryOrderCrmSync('order-1')).rejects.toMatchObject({
      name: 'OrderCrmRetryError',
      statusCode: 400,
      message: 'BeautyPro очікує Grant access у Marketplace',
    } satisfies Partial<OrderCrmRetryError>);
    expect(mirrorAppointmentToCrm).not.toHaveBeenCalled();
  });

  it('returns 404 when the order does not exist', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null);
    await expect(retryOrderCrmSync('missing')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Order not found',
    });
  });

  it('returns 400 when a booking order has no appointmentId in the note', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'Запис без маркера',
      keycrmOrderId: null,
    });
    await expect(retryOrderCrmSync('order-1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mirrorAppointmentToCrm).not.toHaveBeenCalled();
  });

  it('returns 404 when the linked appointment is missing', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique.mockResolvedValue(null);
    await expect(retryOrderCrmSync('order-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('does not push cancelled bookings or orders', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'cancelled',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    await expect(retryOrderCrmSync('order-1')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Скасоване замовлення не відвантажується в CRM',
    });
    expect(prismaMock.appointment.findUnique).not.toHaveBeenCalled();
  });

  it('does not push a cancelled appointment', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique.mockResolvedValue({
      id: 'a0712020-04d1-4863-8ad4-1370d6905921',
      status: 'cancelled',
      crmProvider: 'beautypro',
      crmRecordId: null,
      crmSyncStatus: 'failed',
      crmSyncError: null,
      crmSyncedAt: null,
    });
    await expect(retryOrderCrmSync('order-1')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Скасований запис не відвантажується в CRM',
    });
    expect(mirrorAppointmentToCrm).not.toHaveBeenCalled();
  });

  it('returns 502 when appointment mirror finishes without a CRM id', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique
      .mockResolvedValueOnce({
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        status: 'confirmed',
        crmProvider: 'beautypro',
        crmRecordId: null,
        crmSyncStatus: 'pending',
        crmSyncError: null,
        crmSyncedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: null,
        crmSyncStatus: 'failed',
        crmSyncError: 'TIME_CONFLICT',
        crmSyncedAt: null,
      });
    isCrmWriteReady.mockResolvedValue({ ready: true, enabled: true, source: 'settings', provider: 'beautypro' });
    mirrorAppointmentToCrm.mockResolvedValue(undefined);

    await expect(retryOrderCrmSync('order-1')).rejects.toMatchObject({
      statusCode: 502,
      message: 'TIME_CONFLICT',
    });
  });

  it('passes forceTimeConflict to mirrorAppointmentToCrm for admin override', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      status: 'submitted',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      keycrmOrderId: null,
    });
    prismaMock.appointment.findUnique
      .mockResolvedValueOnce({
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        status: 'confirmed',
        crmProvider: 'beautypro',
        crmRecordId: null,
        crmSyncStatus: 'failed',
        crmSyncError: 'TIME_CONFLICT',
        crmSyncedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: 'bp-forced',
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: new Date(),
      });
    isCrmWriteReady.mockResolvedValue({ ready: true, enabled: true, source: 'settings', provider: 'beautypro' });
    mirrorAppointmentToCrm.mockResolvedValue(undefined);
    reflectAppointmentCrmOnOrder.mockResolvedValue(undefined);

    const result = await retryOrderCrmSync('order-1', { forceTimeConflict: true });

    expect(mirrorAppointmentToCrm).toHaveBeenCalledWith(
      'a0712020-04d1-4863-8ad4-1370d6905921',
      { force: true, forceTimeConflict: true },
    );
    expect(result.crmRecordId).toBe('bp-forced');
  });

  it('returns alreadySynced for a product that already has a KeyCRM id', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-2',
      kind: 'product',
      status: 'submitted',
      note: null,
      keycrmOrderId: '555',
    });
    const result = await retryOrderCrmSync('order-2');
    expect(result.alreadySynced).toBe(true);
    expect(mirrorOrderToCrm).not.toHaveBeenCalled();
  });
});

describe('crmRetrySuccessMessage', () => {
  it('names BeautyPro for a successful booking push', () => {
    expect(
      crmRetrySuccessMessage({
        ok: true,
        alreadySynced: false,
        kind: 'booking',
        crmProvider: 'beautypro',
        crmRecordId: 'bp-1',
        crmSyncStatus: 'synced',
        crmSyncedAt: null,
        crmSyncError: null,
      }),
    ).toBe('Запис відвантажено в BeautyPro');
  });

  it('names KeyCRM for a product order id', () => {
    expect(
      crmRetrySuccessMessage({
        ok: true,
        alreadySynced: false,
        kind: 'product',
        crmProvider: 'keycrm',
        crmRecordId: '42',
        crmSyncStatus: 'synced',
        crmSyncedAt: null,
        crmSyncError: null,
      }),
    ).toBe('Синхронізовано: KeyCRM #42');
  });
});
