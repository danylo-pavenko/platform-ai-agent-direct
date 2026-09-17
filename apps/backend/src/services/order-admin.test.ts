import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  isCrmWriteEnabled,
  isCrmWriteReady,
  mirrorOrderToCrm,
  notifyOrder,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn() },
    order: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  },
  isCrmWriteEnabled: vi.fn(),
  isCrmWriteReady: vi.fn(),
  mirrorOrderToCrm: vi.fn(),
  notifyOrder: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: prismaMock,
  toInputJsonValue: (v: unknown) => v,
}));
vi.mock('../lib/crm-write.js', () => ({ isCrmWriteEnabled, isCrmWriteReady }));
vi.mock('./crm-sync.js', () => ({ mirrorOrderToCrm }));
vi.mock('./telegram-notify.js', () => ({ notifyOrder }));

import { createAdminProductOrder } from './order-admin.js';

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
    expect(notifyOrder).toHaveBeenCalled();
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
      customerName: 'A',
      phone: '1',
      city: 'C',
      npBranch: '2',
    });

    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE' });
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
      customerName: 'A',
      phone: '1',
      city: 'C',
      npBranch: '2',
    });

    expect(result.ok).toBe(true);
    expect(mirrorOrderToCrm).not.toHaveBeenCalled();
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ crmSyncStatus: 'skipped' }),
      }),
    );
  });
});
