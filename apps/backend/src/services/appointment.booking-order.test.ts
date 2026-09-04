import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  resolveBookingBranchForAppointment,
  resolveCrmProvider,
  notifyOrder,
  sendText,
  mirrorCreateBooking,
  isCrmWriteEnabled,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    appointment: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    message: { create: vi.fn() },
    clientReferencePhoto: { findMany: vi.fn() },
    setting: { findUnique: vi.fn() },
  },
  resolveBookingBranchForAppointment: vi.fn(),
  resolveCrmProvider: vi.fn(),
  notifyOrder: vi.fn(),
  sendText: vi.fn(),
  mirrorCreateBooking: vi.fn(),
  isCrmWriteEnabled: vi.fn(async () => false),
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
  isCrmWriteEnabled,
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
  notifyCrmFallback: vi.fn(() => Promise.resolve()),
}));

vi.mock('./instagram.js', () => ({
  sendText,
}));

vi.mock('../lib/conversation-metrics.js', () => ({
  markFirstOutboundAt: vi.fn(async () => undefined),
}));

vi.mock('./client-crm-link.js', () => ({
  persistCrmBuyerIdFromBooking: vi.fn(),
  fetchClientCrmHistory: vi.fn(async () => ({ items: [], provider: null, crmBuyerId: null, text: '' })),
}));

import {
  handleBookAppointment,
  mirrorAppointmentToCrm,
  reflectAppointmentCrmOnOrder,
  updateAppointmentServiceMasters,
} from './appointment.js';

describe('handleBookAppointment Order + Telegram mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCrmWriteEnabled.mockResolvedValue(false);
    resolveCrmProvider.mockResolvedValue('beautypro');
    prismaMock.conversation.findUnique.mockResolvedValue({ branchId: 'branch-1' });
    prismaMock.conversation.update.mockResolvedValue({});
    prismaMock.appointment.findFirst.mockResolvedValue(null);
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
    prismaMock.setting.findUnique.mockResolvedValue({
      key: 'agent_config',
      value: { timezone: 'Europe/Kyiv' },
    });
    notifyOrder.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it('creates booking Order, notifies Telegram, and sends IG confirmation', async () => {
    const result = await handleBookAppointment(
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

    expect(result?.appointmentId).toBe('appt-1');
    expect(result?.crmSynced).toBe(true);
    expect(result?.toolResult).toMatch(/ok id=appt-1/);
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'booking',
          crmSyncStatus: 'skipped',
          status: 'confirmed',
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

  it('replaces confirmation tease with structured details', async () => {
    await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Анжела',
        phone: '+380501112233',
        date: '26.08.2026',
        time: '10:30',
        services: [
          {
            id: 'svc-tips',
            name: 'Стрижка кінчиків',
            duration_min: 30,
            price: 540,
            master_id: 'm-1',
            start_time: '10:30',
          },
          {
            id: 'svc-mani',
            name: 'Манікюр',
            duration_min: 115,
            price: 890,
            master_id: 'm-2',
            start_time: '11:00',
          },
        ],
      },
      {
        clientIgUserId: 'ig-angela',
        clientMessage: 'Оформлюю Ваш запис — зараз надішлю підтвердження з деталями. 🌸',
      },
    );

    const created = prismaMock.appointment.create.mock.calls[0]?.[0] as {
      data: { services: Array<{ startTime?: string; masterId?: string }> };
    };
    expect(created.data.services.map((s) => s.startTime)).toEqual(['10:30', '11:00']);
    expect(sendText).toHaveBeenCalledWith(
      'ig-angela',
      expect.stringMatching(/Запис підтверджено на 26\.08\.2026[\s\S]*Стрижка кінчиків — 10:30[\s\S]*Манікюр — 11:00/),
    );
  });

  it('replaces «передано в обробку» tease even when a clock time is in the copy', async () => {
    await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Анжела',
        phone: '+380501112233',
        date: '29.08.2026',
        time: '10:00',
        services: [
          {
            id: 'svc-mani',
            name: 'Комплекс манікюр',
            duration_min: 115,
            price: 890,
            master_id: 'm-1',
          },
        ],
      },
      {
        clientIgUserId: 'ig-angela',
        clientMessage:
          'Дякую! Ваш запит на запис передано в обробку — щойно система підтвердить бронювання, я одразу надішлю Вам деталі візиту 🌸\n📅 29.08.2026 о 10:00',
      },
    );

    expect(sendText).toHaveBeenCalledWith(
      'ig-angela',
      expect.stringMatching(/Запис підтверджено на 29\.08\.2026[\s\S]*Комплекс манікюр — 10:00/),
    );
    expect(sendText).not.toHaveBeenCalledWith(
      'ig-angela',
      expect.stringMatching(/передано в обробку|доставк/i),
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

    const result = await handleBookAppointment(
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

    expect(result?.appointmentId).toBe('appt-1');
    expect(prismaMock.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch-default',
          scheduledDate: '08.08.2026',
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
    prismaMock.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'order-existing' });

    const result = await handleBookAppointment(
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

    expect(result?.appointmentId).toBe('appt-1');
    expect(prismaMock.order.create).not.toHaveBeenCalled();
    expect(notifyOrder).not.toHaveBeenCalled();
  });

  it('stores a distinct masterId on each service line', async () => {
    await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Анжела',
        phone: '+380501112233',
        date: '21.08.2026',
        time: '12:00',
        services: [
          {
            id: 'svc-manicure',
            name: 'Комплекс манікюр',
            duration_min: 115,
            price: 820,
            master_id: 'master-nails',
          },
          {
            id: 'svc-brows',
            name: 'Брови',
            duration_min: 30,
            price: 350,
            master_id: 'master-brows',
          },
        ],
        master_id: 'master-nails',
      },
      { skipClientMessage: true },
    );

    const created = prismaMock.appointment.create.mock.calls[0]?.[0] as {
      data: { services: Array<{ masterId?: string }>; };
    };
    expect(created.data.services.map((s) => s.masterId)).toEqual(['master-nails', 'master-brows']);
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          note: expect.stringMatching(/master_id=master-nails[\s\S]*master_id=master-brows|master_id=master-brows[\s\S]*master_id=master-nails/),
        }),
      }),
    );
  });

  it('merges second book_appointment on the same slot into one visit', async () => {
    prismaMock.appointment.findFirst.mockResolvedValue({
      id: 'appt-existing',
      services: [{ id: 'svc-1', durationMin: 60, masterId: 'm-1', name: 'Манікюр', price: 500 }],
      crmRecordId: null,
      crmSyncStatus: 'pending',
      crmSyncError: null,
      crmSyncedAt: null,
      branchId: 'branch-1',
    });
    prismaMock.appointment.update.mockResolvedValue({ id: 'appt-existing' });
    prismaMock.appointment.findUnique.mockResolvedValue({
      services: [
        { id: 'svc-1', durationMin: 60, masterId: 'm-1', name: 'Манікюр', price: 500 },
        { id: 'svc-2', durationMin: 30, masterId: 'm-2', name: 'Брови', price: 350 },
      ],
    });
    prismaMock.order.findFirst.mockResolvedValue({
      id: 'order-1',
      items: [{ name: 'Манікюр', price: 500, qty: 1 }],
      note: 'appointmentId=appt-existing',
    });

    const result = await handleBookAppointment(
      'conv-1',
      'client-1',
      {
        customer_name: 'Анжела',
        phone: '+380501112233',
        date: '2026-08-08',
        time: '11:00',
        services: [{ id: 'svc-2', name: 'Брови', duration_min: 30, price: 350, master_id: 'm-2' }],
      },
      { skipClientMessage: true },
    );

    expect(prismaMock.appointment.create).not.toHaveBeenCalled();
    expect(prismaMock.appointment.update).toHaveBeenCalled();
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ name: 'Манікюр' }),
            expect.objectContaining({ name: 'Брови' }),
          ]),
        }),
      }),
    );
    expect(result?.toolResult).toContain('merged');
  });
});

describe('reflectAppointmentCrmOnOrder + mirrorAppointmentToCrm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCrmWriteEnabled.mockResolvedValue(true);
    resolveCrmProvider.mockResolvedValue('beautypro');
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.appointment.update.mockResolvedValue({});
    prismaMock.clientReferencePhoto.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({
      key: 'agent_config',
      value: { timezone: 'Europe/Kyiv' },
    });
  });

  it('copies appointment CRM status onto the booking Order', async () => {
    const syncedAt = new Date('2026-08-18T10:00:00.000Z');
    await reflectAppointmentCrmOnOrder({
      id: 'appt-1',
      crmRecordId: 'bp-1',
      crmSyncStatus: 'synced',
      crmSyncError: null,
      crmSyncedAt: syncedAt,
    });
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { kind: 'booking', note: { contains: 'appointmentId=appt-1' } },
      data: {
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: syncedAt,
      },
    });
  });

  it('marks appointment failed when branch CRM id is missing', async () => {
    prismaMock.appointment.findUnique.mockResolvedValue({
      id: 'appt-1',
      crmRecordId: null,
      crmSyncStatus: 'pending',
      crmSyncedAt: null,
      branchId: null,
      branch: null,
      client: { igUserId: 'ig-1' },
      clientId: 'client-1',
      conversationId: 'conv-1',
      services: [{ id: 'svc-1', durationMin: 60 }],
      scheduledDate: '2026-08-21',
      scheduledTime: '12:00',
      customerName: 'Анжела',
      phone: '0930152179',
      comment: null,
    });
    resolveBookingBranchForAppointment.mockResolvedValue(null);

    await expect(mirrorAppointmentToCrm('appt-1', { force: true })).rejects.toThrow(
      'Branch CRM external id missing',
    );
    expect(prismaMock.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'appt-1' },
        data: expect.objectContaining({ crmSyncStatus: 'failed', status: 'failed' }),
      }),
    );
    expect(prismaMock.order.updateMany).toHaveBeenCalled();
    expect(mirrorCreateBooking).not.toHaveBeenCalled();
  });

  it('updates per-service masters and CRM retry reads both ids', async () => {
    prismaMock.appointment.findUnique.mockResolvedValue({
      id: 'appt-1',
      crmRecordId: null,
      crmSyncStatus: 'failed',
      crmSyncedAt: null,
      branchId: 'branch-1',
      branch: { crmExternalId: 'loc-1' },
      client: { igUserId: 'ig-1' },
      clientId: 'client-1',
      conversationId: 'conv-1',
      services: [
        { id: 'svc-1', durationMin: 115, name: 'Манікюр', masterId: 'nails' },
        { id: 'svc-2', durationMin: 30, name: 'Брови' },
      ],
      scheduledDate: '21.08.2026',
      scheduledTime: '12:00',
      customerName: 'Анжела',
      phone: '0930152179',
      comment: null,
      status: 'failed',
    });
    prismaMock.appointment.update.mockResolvedValue({});
    const patched = await updateAppointmentServiceMasters({
      appointmentId: 'appt-1',
      assignments: [{ index: 1, masterId: 'brows' }],
    });
    expect(patched.services.map((s) => s.masterId)).toEqual(['nails', 'brows']);

    prismaMock.appointment.findUnique.mockResolvedValue({
      id: 'appt-1',
      crmRecordId: null,
      crmSyncStatus: 'failed',
      crmSyncedAt: null,
      branchId: 'branch-1',
      branch: { crmExternalId: 'loc-1' },
      client: { igUserId: 'ig-1' },
      clientId: 'client-1',
      conversationId: 'conv-1',
      services: patched.services,
      scheduledDate: '21.08.2026',
      scheduledTime: '12:00',
      customerName: 'Анжела',
      phone: '0930152179',
      comment: null,
      status: 'failed',
    });
    mirrorCreateBooking.mockResolvedValue({ crmRecordId: 'bp-1' });

    await mirrorAppointmentToCrm('appt-1', { force: true });
    expect(mirrorCreateBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [
          expect.objectContaining({ id: 'svc-1', masterId: 'nails' }),
          expect.objectContaining({ id: 'svc-2', masterId: 'brows' }),
        ],
      }),
    );
  });
});
