import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  resolveBookingBranchForAppointment,
  resolveCrmProvider,
  notifyOrder,
  sendText,
  mirrorCreateBooking,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    appointment: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), create: vi.fn() },
    message: { create: vi.fn() },
    clientReferencePhoto: { findMany: vi.fn() },
  },
  resolveBookingBranchForAppointment: vi.fn(),
  resolveCrmProvider: vi.fn(),
  notifyOrder: vi.fn(),
  sendText: vi.fn(),
  mirrorCreateBooking: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    TENANT_KNOWLEDGE_DIR: undefined,
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: prismaMock,
  toInputJsonValue: (v: unknown) => v,
}));

vi.mock('../lib/crm-write.js', () => ({
  isCrmWriteEnabled: vi.fn(async () => false),
}));

vi.mock('../lib/crm-routing.js', () => ({
  resolveCrmProvider,
}));

vi.mock('./booking-branch.js', () => ({
  resolveBookingBranchForAppointment,
  resolveBookingBranchCrmId: vi.fn(),
}));

vi.mock('./crm/index.js', () => ({
  getCrmAdapter: () => ({
    name: 'beautypro',
    createBooking: mirrorCreateBooking,
  }),
}));

vi.mock('./telegram-notify.js', () => ({
  notifyOrder,
  notifyCrmFallback: vi.fn(),
}));

vi.mock('./instagram.js', () => ({
  sendText,
}));

vi.mock('../lib/conversation-metrics.js', () => ({
  markFirstOutboundAt: vi.fn(async () => undefined),
}));

vi.mock('./client-crm-link.js', () => ({
  persistCrmBuyerIdFromBooking: vi.fn(),
}));

import { handleBookAppointment } from './appointment.js';

describe('handleBookAppointment Order + Telegram mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCrmProvider.mockResolvedValue('beautypro');
    prismaMock.conversation.findUnique.mockResolvedValue({ branchId: 'branch-1' });
    prismaMock.conversation.update.mockResolvedValue({});
    resolveBookingBranchForAppointment.mockResolvedValue({
      branchId: 'branch-1',
      crmExternalId: 'loc-1',
      displayName: 'Центр',
      source: 'conversation',
    });
    prismaMock.appointment.create.mockResolvedValue({ id: 'appt-1' });
    prismaMock.order.findFirst.mockResolvedValue(null);
    prismaMock.order.create.mockResolvedValue({ id: 'order-1' });
    prismaMock.message.create.mockResolvedValue({ id: 'msg-1' });
    notifyOrder.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it('creates booking Order, notifies Telegram, and sends IG confirmation', async () => {
    const id = await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Анжела',
        phone: '+380501112233',
        date: '2026-08-08',
        time: '11:00',
        services: [
          {
            id: '88d8645d-2022-fa67-6d46-f6ed12f7a6a2',
            name: 'Комплекс манікюр',
            duration_min: 115,
            price: 820,
          },
        ],
        master_id: 'master-1',
      },
      {
        clientIgUserId: 'ig-angela',
        clientMessage: '820 грн. Чекаємо тебе завтра о 11:00!',
      },
    );

    expect(id).toBe('appt-1');
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'booking',
          crmSyncStatus: 'skipped',
          status: 'submitted',
          customerName: 'Анжела',
          phone: '+380501112233',
        }),
      }),
    );
    expect(notifyOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'booking',
        clientIgUserId: 'ig-angela',
        orderId: 'order-1',
      }),
    );
    expect(sendText).toHaveBeenCalledWith(
      'ig-angela',
      '820 грн. Чекаємо тебе завтра о 11:00!',
    );
  });

  it('falls back to default CRM location when conversation has no branch', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({ branchId: null });
    resolveBookingBranchForAppointment.mockResolvedValue({
      branchId: 'branch-default',
      crmExternalId: 'bp-loc',
      displayName: 'Moxito',
      source: 'default',
    });

    const id = await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Данило',
        phone: '380958959421',
        date: '08.08.2026',
        time: '13:30',
        services: [
          {
            id: '88dc2f9d-9e3d-b93a-2c65-995c1eeca95b',
            name: 'Гігієнічна чистка + японський манікюр',
            duration_min: 60,
            price: 500,
          },
        ],
        master_id: '88de0aea-4b21-cc54-452f-f5687b3b1ec6',
      },
      { clientIgUserId: 'ig-danylo', skipClientMessage: true },
    );

    expect(id).toBe('appt-1');
    expect(prismaMock.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch-default',
          scheduledDate: '2026-08-08',
          scheduledTime: '13:30',
        }),
      }),
    );
    expect(prismaMock.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-1' },
        data: { branchId: 'branch-default' },
      }),
    );
    expect(prismaMock.order.create).toHaveBeenCalled();
  });

  it('dedupes booking Order within window', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-existing' });

    const id = await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Анжела',
        phone: '+380501112233',
        date: '2026-08-08',
        time: '11:00',
        services: [{ id: 'svc-1', name: 'Манікюр', duration_min: 60, price: 500 }],
      },
      { clientIgUserId: 'ig-angela', skipClientMessage: true },
    );

    expect(id).toBe('appt-1');
    expect(prismaMock.order.create).not.toHaveBeenCalled();
    expect(notifyOrder).not.toHaveBeenCalled();
  });
});
