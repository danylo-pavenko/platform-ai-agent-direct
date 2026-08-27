import { describe, expect, it, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn().mockResolvedValue({});

vi.mock('../lib/telegram.js', () => ({
  getBot: vi.fn(),
  getBotWithToken: vi.fn(() => ({
    api: { sendMessage },
  })),
}));
vi.mock('../lib/telegram-groups.js', () => ({
  getNotificationChatIds: vi.fn().mockResolvedValue(['-100123']),
  getNotificationChatIdsForBot: vi.fn().mockResolvedValue(['-100123']),
}));
vi.mock('../lib/integration-config.js', () => ({
  getIntegrationConfig: vi.fn().mockResolvedValue({
    // Legacy shape without bots[] — must still work via normalizeTelegramConfig
    telegram: { botToken: 'test-token', managerGroupId: '', adminPassword: '' },
  }),
}));
vi.mock('../config.js', () => ({
  config: { INSTANCE_ID: 'sb', ADMIN_DOMAIN: 'agent.example.com' },
}));

import { getBotWithToken } from '../lib/telegram.js';
import { notifyOrder } from './telegram-notify.js';

describe('notifyOrder', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    vi.mocked(getBotWithToken).mockReturnValue({
      api: { sendMessage },
    } as never);
  });

  it('sends HTML card even when item name is missing', async () => {
    await notifyOrder({
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      conversationId: 'ffffffff-1111-2222-3333-444444444444',
      clientIgUserId: '17841410659012767',
      items: [{ name: '', price: 2189, qty: 1 }],
      customerName: 'Тест',
      phone: '+380501234567',
      city: 'Київ',
      npBranch: '47',
      paymentMethod: 'cod',
    });

    expect(getBotWithToken).toHaveBeenCalledWith('test-token');
    expect(sendMessage).toHaveBeenCalledOnce();
    const [groupId, text, options] = sendMessage.mock.calls[0];
    expect(groupId).toBe('-100123');
    expect(text).toContain('Нове замовлення');
    expect(text).toContain('Товар');
    expect(text).toContain('Післяплата');
    expect(text).toContain('agent.example.com/conversations/');
    expect(options?.reply_markup).toBeDefined();
  });

  it('sends booking as notify-only without approve/decline buttons', async () => {
    await notifyOrder({
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      conversationId: 'ffffffff-1111-2222-3333-444444444444',
      clientIgUserId: '17841410659012767',
      items: [
        { name: 'Комплекс манікюр', price: 890, qty: 1 },
        { name: 'Педикюр', price: 700, qty: 1 },
      ],
      customerName: 'Анжела',
      phone: '+380930152179',
      npBranch: '29.08.2026 10:00',
      kind: 'booking',
      summary: 'манікюр+педикюр+брови',
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [, text, options] = sendMessage.mock.calls[0];
    expect(text).toContain('Запис оформлено');
    expect(text).toContain('Агент оформив запис');
    expect(text).toContain('підтвердження');
    expect(text).not.toMatch(/доставк/i);
    expect(options?.reply_markup).toBeUndefined();
  });
});
