import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  isCrmWriteReady,
  createAdminProductOrder,
  retryOrderCrmSync,
  linkClientToCrm,
  mirrorClientToCrm,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn(), findMany: vi.fn() },
    client: { findUnique: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn() },
  },
  isCrmWriteReady: vi.fn(),
  createAdminProductOrder: vi.fn(),
  retryOrderCrmSync: vi.fn(),
  linkClientToCrm: vi.fn(),
  mirrorClientToCrm: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/crm-write.js', () => ({ isCrmWriteReady }));
vi.mock('./order-admin.js', () => ({ createAdminProductOrder }));
vi.mock('./order-crm-retry.js', () => ({
  retryOrderCrmSync,
  OrderCrmRetryError: class OrderCrmRetryError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'OrderCrmRetryError';
    }
  },
}));
vi.mock('./client-crm-link.js', () => ({ linkClientToCrm }));
vi.mock('./crm-sync.js', () => ({ mirrorClientToCrm }));

import {
  buildInsightsToolDefinitions,
  executeInsightsToolCall,
  parseConversationId,
} from './insights-tools.js';

describe('insights-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCrmWriteReady.mockResolvedValue({
      ready: true,
      enabled: true,
      source: 'settings',
      provider: 'keycrm',
    });
  });

  it('parses conversation UUID from admin path', () => {
    expect(
      parseConversationId(
        'https://admin.example/conversations/a0712020-04d1-4863-8ad4-1370d6905921?x=1',
      ),
    ).toBe('a0712020-04d1-4863-8ad4-1370d6905921');
  });

  it('exposes the MVP tool set', () => {
    const names = buildInsightsToolDefinitions().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_conversation',
        'search_conversations',
        'get_client',
        'propose_product_order',
        'create_product_order',
        'propose_client_update',
        'update_client',
        'get_crm_write_status',
        'retry_order_crm_sync',
      ]),
    );
  });

  it('refuses create_product_order without confirm', async () => {
    const out = await executeInsightsToolCall({
      name: 'create_product_order',
      args: {
        conversation_id: 'a0712020-04d1-4863-8ad4-1370d6905921',
        items: [{ name: 'Hoodie', price: 100 }],
        customer_name: 'A',
        phone: '1',
        city: 'Kyiv',
        np_branch: '1',
      },
    });
    expect(out).toContain('confirm=true');
    expect(createAdminProductOrder).not.toHaveBeenCalled();
  });

  it('creates product order when confirm=true', async () => {
    createAdminProductOrder.mockResolvedValue({
      ok: true,
      orderId: 'ord-1',
      alreadyExisted: false,
      crmSyncStatus: 'synced',
      keycrmOrderId: 'kc-1',
      crmSyncError: null,
      conversationId: 'a0712020-04d1-4863-8ad4-1370d6905921',
      path: '/conversations/a0712020-04d1-4863-8ad4-1370d6905921',
    });

    const out = await executeInsightsToolCall({
      name: 'create_product_order',
      args: {
        conversation_id: '/conversations/a0712020-04d1-4863-8ad4-1370d6905921',
        items: [{ name: 'Hoodie', price: 2189, qty: 1 }],
        customer_name: 'Губеня',
        phone: '+38099',
        city: 'Київ',
        np_branch: '12',
        payment_method: 'card',
        confirm: true,
      },
    });

    expect(createAdminProductOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'a0712020-04d1-4863-8ad4-1370d6905921',
        customerName: 'Губеня',
        paymentMethod: 'card',
      }),
    );
    expect(out).toContain('СТВОРЕНО');
    expect(out).toContain('ord-1');
  });

  it('loads conversation transcript for owner', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'a0712020-04d1-4863-8ad4-1370d6905921',
      state: 'handoff',
      channel: 'instagram',
      intent: null,
      handoffReason: 'payment',
      client: {
        id: 'c1',
        displayName: 'Test',
        igUsername: 'u',
        igFullName: null,
        phone: '+380',
        email: null,
        deliveryCity: 'Kyiv',
        deliveryNpBranch: '1',
        deliveryNpType: null,
        notes: null,
        tags: [],
        crmBuyerId: null,
        crmProvider: null,
      },
      messages: [
        {
          id: 'm1',
          direction: 'in',
          sender: 'client',
          text: 'Давайте карту',
          createdAt: new Date('2026-09-01T10:00:00Z'),
          mediaUrls: null,
          mediaAttachments: null,
        },
      ],
      orders: [],
    });

    const out = await executeInsightsToolCall({
      name: 'get_conversation',
      args: { conversation_id: 'a0712020-04d1-4863-8ad4-1370d6905921' },
    });
    expect(out).toContain('Давайте карту');
    expect(out).toContain('/conversations/a0712020-04d1-4863-8ad4-1370d6905921');
  });
});
