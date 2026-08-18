import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  retryOrderCrmSync,
  OrderCrmRetryError,
  crmRetrySuccessMessage,
  resolveKeycrmAppUrl,
  listBookingMasters,
  updateAppointmentServiceMasters,
  AppointmentUpdateError,
} = vi.hoisted(() => {
  class OrderCrmRetryError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly extra?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'OrderCrmRetryError';
    }
  }
  class AppointmentUpdateError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AppointmentUpdateError';
    }
  }
  return {
    prismaMock: {
      order: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
      appointment: { findMany: vi.fn(), findUnique: vi.fn() },
    },
    retryOrderCrmSync: vi.fn(),
    OrderCrmRetryError,
    crmRetrySuccessMessage: vi.fn((result: { kind: string }) =>
      result.kind === 'booking' ? 'Запис відвантажено в BeautyPro' : 'ok',
    ),
    resolveKeycrmAppUrl: vi.fn(async () => null),
    listBookingMasters: vi.fn(async () => [{ id: 'm1', name: 'Анна' }]),
    updateAppointmentServiceMasters: vi.fn(),
    AppointmentUpdateError,
  };
});

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/keycrm-urls.js', () => ({
  resolveKeycrmAppUrl,
  buildKeycrmOrderUrl: vi.fn(
    (id: string, base: string | null) => (base ? `${base}/app/orders/view/${id}` : null),
  ),
}));
vi.mock('../services/order-crm-retry.js', () => ({
  retryOrderCrmSync,
  OrderCrmRetryError,
  crmRetrySuccessMessage,
}));
vi.mock('../services/appointment.js', () => ({
  listBookingMasters,
  updateAppointmentServiceMasters,
  AppointmentUpdateError,
}));

import { orderRoutes } from './orders.js';

describe('order routes CRM overlay + retry', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    resolveKeycrmAppUrl.mockResolvedValue(null);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async () => {});
    await app.register(orderRoutes, { prefix: '/orders' });
    return app;
  }

  it('overlays appointment CRM status on skipped booking orders', async () => {
    prismaMock.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        conversationId: 'conv-1',
        clientId: 'client-1',
        kind: 'booking',
        items: [{ name: 'Комплекс манікюр', price: 820, qty: 1 }],
        customerName: 'Тимофіїв Анжела',
        phone: '0930152179',
        city: null,
        npBranch: null,
        paymentMethod: null,
        note: 'Запис appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
        status: 'submitted',
        submittedToManagerAt: new Date(),
        keycrmOrderId: null,
        crmSyncStatus: 'skipped',
        crmSyncError: null,
        crmSyncedAt: null,
        isArchived: false,
        archivedAt: null,
        createdAt: new Date(),
        client: { id: 'client-1', igUserId: null, displayName: 'Тимофіїв Анжела' },
        conversation: { id: 'conv-1' },
      },
    ]);
    prismaMock.order.count.mockResolvedValue(1);
    prismaMock.appointment.findMany.mockResolvedValue([
      {
        id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        crmProvider: 'beautypro',
        crmRecordId: 'bp-appt',
        crmSyncStatus: 'synced',
        crmSyncError: null,
        crmSyncedAt: new Date('2026-08-18T10:00:00.000Z'),
        status: 'synced',
        services: [
          { id: 'svc-1', name: 'Комплекс манікюр', durationMin: 115, masterId: 'nails' },
          { id: 'svc-2', name: 'Брови', durationMin: 30 },
        ],
      },
    ]);

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/orders' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data[0].crmSyncStatus).toBe('synced');
    expect(body.data[0].crmProviderLabel).toBe('BeautyPro');
    expect(body.data[0].crmRecordId).toBe('bp-appt');
    expect(body.data[0].canRetryCrm).toBe(false);
    expect(body.data[0].keycrmOrderUrl).toBeNull();
    expect(body.data[0].appointmentServices).toEqual([
      { id: 'svc-1', name: 'Комплекс манікюр', durationMin: 115, masterId: 'nails' },
      { id: 'svc-2', name: 'Брови', durationMin: 30 },
    ]);
  });

  it('lists booking masters for the admin select', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/orders/booking-masters' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ id: 'm1', name: 'Анна' }]);
  });

  it('patches per-service masters on a booking order', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      status: 'submitted',
    });
    updateAppointmentServiceMasters.mockResolvedValue({
      services: [
        { id: 'svc-1', durationMin: 115, name: 'Манікюр', masterId: 'nails' },
        { id: 'svc-2', durationMin: 30, name: 'Брови', masterId: 'brows' },
      ],
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/orders/order-1/booking-services',
      payload: {
        services: [
          { index: 0, masterId: 'nails' },
          { index: 1, masterId: 'brows' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(updateAppointmentServiceMasters).toHaveBeenCalledWith({
      appointmentId: 'a0712020-04d1-4863-8ad4-1370d6905921',
      assignments: [
        { index: 0, masterId: 'nails' },
        { index: 1, masterId: 'brows' },
      ],
      force: undefined,
    });
    expect(response.json().services.map((s: { masterId: string }) => s.masterId)).toEqual([
      'nails',
      'brows',
    ]);
  });

  it('maps appointment update errors to HTTP 400', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      kind: 'booking',
      note: 'appointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      status: 'submitted',
    });
    updateAppointmentServiceMasters.mockRejectedValue(
      new AppointmentUpdateError('Запис уже в CRM — майстрів не змінюємо без force', 400),
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/orders/order-1/booking-services',
      payload: { services: [{ index: 1, masterId: 'brows' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/force/);
  });

  it('maps retry errors to HTTP status codes', async () => {
    retryOrderCrmSync.mockRejectedValue(
      new OrderCrmRetryError('BeautyPro очікує Grant access у Marketplace', 400, {
        crmWrite: { ready: false },
      }),
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/orders/order-1/sync-crm',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Marketplace/);
  });

  it('returns the booking retry payload without a KeyCRM id', async () => {
    retryOrderCrmSync.mockResolvedValue({
      ok: true,
      alreadySynced: false,
      kind: 'booking',
      crmProvider: 'beautypro',
      crmRecordId: 'bp-1',
      crmSyncStatus: 'synced',
      crmSyncedAt: '2026-08-18T10:00:00.000Z',
      crmSyncError: null,
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/orders/order-1/sync-crm',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.crmRecordId).toBe('bp-1');
    expect(body.keycrmOrderId).toBeNull();
    expect(body.message).toBe('Запис відвантажено в BeautyPro');
  });
});
