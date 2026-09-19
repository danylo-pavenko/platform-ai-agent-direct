import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  isCrmWriteEnabled,
  isCrmWriteReady,
  mirrorOrderToCrm,
  notifyOrder,
  cancelAppointmentById,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn() },
    order: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  isCrmWriteEnabled: vi.fn(),
  isCrmWriteReady: vi.fn(),
  mirrorOrderToCrm: vi.fn(),
  notifyOrder: vi.fn(),
  cancelAppointmentById: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: prismaMock,
  toInputJsonValue: (v: unknown) => v,
}));
vi.mock('../lib/crm-write.js', () => ({ isCrmWriteEnabled, isCrmWriteReady }));
vi.mock('./crm-sync.js', () => ({ mirrorOrderToCrm }));
vi.mock('./telegram-notify.js', () => ({ notifyOrder }));
vi.mock('./appointment.js', () => ({
  cancelAppointmentById,
  AppointmentUpdateError: class AppointmentUpdateError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'AppointmentUpdateError';
    }
  },
}));

import { cancelAdminOrder, createAdminProductOrder, OrderCancelError } from './order-admin.js';

describe('createAdminProductOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifyOrder.mockResolvedValue(undefined);
    isCrmWriteReady.mockResolvedValue({
      ready: true,
      enabled: true,
      source: 'settings',
      provider: 'keycrm',
    });
    isCrmWriteEnabled.mockResolvedValue(true);
  });

  it('creates order in handoff without IG and mirrors CRM', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      state: 'handoff',
      clientId: 'client-1',
      client: { igUserId: 'ig-1' },
    });
    prismaMock.order.findFirst.mockResolvedValue(null);
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      crmSyncStatus: 'pending',
    });
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      crmSyncStatus: 'synced',
      keycrmOrderId: 'kc-9',
      crmSyncError: null,
    });
    mirrorOrderToCrm.mockResolvedValue(undefined);

    const result = await createAdminProductOrder({
      conversationId: 'conv-1',
      items: [{ name: 'Hoodie', price: 2189, qty: 1 }],
      quotedTotal: 2000,
      customerName: 'Test User',
      phone: '+380991112233',
      city: 'Київ',
      npBranch: '1',
      paymentMethod: 'card',
    });

    expect(result).toMatchObject({
      ok: true,
      orderId: 'order-1',
      keycrmOrderId: 'kc-9',
      path: '/conversations/conv-1',
    });
    expect(mirrorOrderToCrm).toHaveBeenCalledWith('order-1', { force: true });
    expect(notifyOrder).toHaveBeenCalledWith(
      expect.objectContaining({ quotedTotal: 2000 }),
    );
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quotedTotal: 2000 }),
      }),
    );
  });

  it('refuses duplicate product order without force', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      state: 'bot',
      clientId: 'client-1',
      client: { igUserId: 'ig-1' },
    });
    prismaMock.order.findFirst.mockResolvedValue({
      id: 'existing',
      crmSyncStatus: 'synced',
      keycrmOrderId: 'kc-1',
      crmSyncError: null,
    });

    const result = await createAdminProductOrder({
      conversationId: 'conv-1',
      items: [{ name: 'X', price: 1 }],
      quotedTotal: 1,
      customerName: 'A',
      phone: '1',
      city: 'C',
      npBranch: '2',
    });

    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(prismaMock.order.create).not.toHaveBeenCalled();
  });

  it('rejects missing quotedTotal', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      state: 'handoff',
      clientId: 'client-1',
      client: { igUserId: 'ig-1' },
    });

    const result = await createAdminProductOrder({
      conversationId: 'conv-1',
      items: [{ name: 'X', price: 10 }],
      quotedTotal: Number.NaN,
      customerName: 'A',
      phone: '1',
      city: 'C',
      npBranch: '2',
    });

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(prismaMock.order.create).not.toHaveBeenCalled();
  });

  it('skips CRM mirror when write not ready', async () => {
    isCrmWriteReady.mockResolvedValue({
      ready: false,
      enabled: false,
      source: 'none',
      provider: 'keycrm',
      reason: 'off',
    });
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      state: 'handoff',
      clientId: 'client-1',
      client: { igUserId: 'ig-1' },
    });
    prismaMock.order.findFirst.mockResolvedValue(null);
    prismaMock.order.create.mockResolvedValue({
      id: 'order-2',
      crmSyncStatus: 'skipped',
    });
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-2',
      crmSyncStatus: 'skipped',
      keycrmOrderId: null,
      crmSyncError: null,
    });

    const result = await createAdminProductOrder({
      conversationId: 'conv-1',
      items: [{ name: 'X', price: 10 }],
      quotedTotal: 10,
      customerName: 'A',
      phone: '1',
      city: 'C',
      npBranch: '2',
    });

    expect(result.ok).toBe(true);
    expect(mirrorOrderToCrm).not.toHaveBeenCalled();
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ crmSyncStatus: 'skipped', quotedTotal: 10 }),
      }),
    );
  });
});

describe('cancelAdminOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels a product order locally', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'ord-1',
      kind: 'product',
      status: 'submitted',
      note: null,
      conversationId: 'conv-1',
    });
    prismaMock.order.update.mockResolvedValue({});

    const result = await cancelAdminOrder('ord-1', { reason: 'test' });

    expect(result).toMatchObject({
      ok: true,
      orderId: 'ord-1',
      kind: 'product',
      crmCancelled: false,
    });
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord-1' },
        data: expect.objectContaining({ status: 'cancelled', isArchived: true }),
      }),
    );
    expect(cancelAppointmentById).not.toHaveBeenCalled();
  });

  it('cancels booking via appointment helper', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'ord-b',
      kind: 'booking',
      status: 'confirmed',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      conversationId: 'conv-1',
    });
    cancelAppointmentById.mockResolvedValue({
      appointmentId: 'a0712020-04d1-4863-8ad4-1370d6905921',
      crmCancelled: true,
      crmError: null,
      crmSkipped: false,
    });

    const result = await cancelAdminOrder('ord-b', { cancelCrm: true });

    expect(cancelAppointmentById).toHaveBeenCalledWith(
      'a0712020-04d1-4863-8ad4-1370d6905921',
      { reason: 'Скасовано менеджером в адмінці', cancelCrm: true },
    );
    expect(result).toMatchObject({
      ok: true,
      appointmentId: 'a0712020-04d1-4863-8ad4-1370d6905921',
      crmCancelled: true,
    });
  });

  it('cancels booking locally without CRM when cancelCrm is false', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'ord-b',
      kind: 'booking',
      status: 'confirmed',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      conversationId: 'conv-1',
    });
    cancelAppointmentById.mockResolvedValue({
      appointmentId: 'a0712020-04d1-4863-8ad4-1370d6905921',
      crmCancelled: false,
      crmError: null,
      crmSkipped: true,
    });

    const result = await cancelAdminOrder('ord-b', { cancelCrm: false });

    expect(cancelAppointmentById).toHaveBeenCalledWith(
      'a0712020-04d1-4863-8ad4-1370d6905921',
      { reason: 'Скасовано менеджером в адмінці', cancelCrm: false },
    );
    expect(result.crmSkipped).toBe(true);
  });

  it('rejects already cancelled orders', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'ord-1',
      kind: 'product',
      status: 'cancelled',
      note: null,
      conversationId: 'conv-1',
    });

    await expect(cancelAdminOrder('ord-1')).rejects.toBeInstanceOf(OrderCancelError);
  });
});
