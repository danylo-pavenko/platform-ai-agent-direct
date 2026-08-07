import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  getBranchById,
  resolveCrmProvider,
  notifyOrder,
  sendText,
  mirrorCreateBooking,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn() },
    appointment: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), create: vi.fn() },
    message: { create: vi.fn() },
    clientReferencePhoto: { findMany: vi.fn() },
  },
  getBranchById: vi.fn(),
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

vi.mock('./branches.js', () => ({
  getBranchById,
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
    getBranchById.mockResolvedValue({
      id: 'branch-1',
      crmExternalId: 'loc-1',
      displayName: 'Центр',
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
