import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/telegram.js', () => ({
  getBot: vi.fn(),
}));
vi.mock('../lib/telegram-groups.js', () => ({
  getNotificationGroupIds: vi.fn().mockResolvedValue(['-100123']),
}));
vi.mock('../lib/integration-config.js', () => ({
  getIntegrationConfig: vi.fn().mockResolvedValue({
    telegram: { botToken: 'test-token', managerGroupId: '', adminPassword: '' },
  }),
}));
vi.mock('../config.js', () => ({
  config: { INSTANCE_ID: 'sb', ADMIN_DOMAIN: 'agent.example.com' },
}));

import { getBot } from '../lib/telegram.js';
import { notifyOrder } from './telegram-notify.js';

describe('notifyOrder', () => {
  beforeEach(() => {
    vi.mocked(getBot).mockResolvedValue({
      api: { sendMessage: vi.fn().mockResolvedValue({}) },
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

    const bot = await getBot();
    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    const [groupId, text] = vi.mocked(bot.api.sendMessage).mock.calls[0];
    expect(groupId).toBe('-100123');
    expect(text).toContain('Нове замовлення');
    expect(text).toContain('Товар');
    expect(text).toContain('Післяплата');
    expect(text).toContain('agent.example.com/conversations/');
  });
});
