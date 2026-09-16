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
  filterChatIdsForAudience: (ids: string[], audience: 'all' | 'private' | 'groups') => {
    if (audience === 'all') return ids;
    const isPrivate = (id: string) => Number(id) > 0;
    if (audience === 'private') return ids.filter(isPrivate);
    return ids.filter((id) => !isPrivate(id));
  },
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
import { getNotificationChatIdsForBot } from '../lib/telegram-groups.js';
import { notifyHandoff, notifyHandoffFollowUp, notifyOrder } from './telegram-notify.js';
import { AGENT_TURN_DEBUG_PREFIX } from '../lib/agent-turn-debug.js';

describe('notifyOrder', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    vi.mocked(getBotWithToken).mockReturnValue({
      api: { sendMessage },
    } as never);
    vi.mocked(getNotificationChatIdsForBot).mockResolvedValue(['-100123']);
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
    expect(text).toContain('Тест');
    expect(text).not.toContain('17841410659012767');
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

describe('notifyHandoffFollowUp', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    vi.mocked(getBotWithToken).mockReturnValue({
      api: { sendMessage },
    } as never);
    vi.mocked(getNotificationChatIdsForBot).mockResolvedValue(['-100123']);
  });

  it('sends a short card without takeover buttons', async () => {
    await notifyHandoffFollowUp({
      conversationId: 'ffffffff-1111-2222-3333-444444444444',
      clientIgUserId: '17841410659012767',
      clientIgUsername: 'cultura',
      text: '📞 +380979931530',
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [, text, options] = sendMessage.mock.calls[0];
    expect(text).toContain('під час ескалації');
    expect(text).toContain('+380979931530');
    expect(text).toContain('@cultura');
    expect(text).not.toContain('17841410659012767');
    expect(text).not.toContain('Розмова:');
    expect(options?.reply_markup).toBeUndefined();
  });
});

describe('notifyHandoff', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    vi.mocked(getBotWithToken).mockReturnValue({
      api: { sendMessage },
    } as never);
    vi.mocked(getNotificationChatIdsForBot).mockResolvedValue(['-100123', '987654321']);
  });

  it('sends debug dumps only to private bot DMs, not groups', async () => {
    await notifyHandoff({
      conversationId: 'ffffffff-1111-2222-3333-444444444444',
      clientIgUserId: '3380613918779953',
      clientDisplayName: 'Оля',
      clientIgUsername: 'ola.fit',
      reason: 'Потрібна консультація',
      lastMessages: [
        { sender: 'client', text: 'Бачила у інстаграм', isVoice: false },
        { sender: 'bot', text: 'Зачекайте, будь ласка, зʼєдную Вас з менеджером.', isVoice: false },
        {
          sender: 'system',
          text: `${AGENT_TURN_DEBUG_PREFIX}\n• Режим: sales\n• Claude spawns: 1`,
          isVoice: false,
        },
      ],
    });

    const byChat = Object.fromEntries(
      sendMessage.mock.calls.map(([chatId, text]) => [chatId, text as string]),
    );
    expect(Object.keys(byChat).sort()).toEqual(['-100123', '987654321']);

    expect(byChat['-100123']).toContain('Ескалація до менеджера');
    expect(byChat['-100123']).toContain('Оля');
    expect(byChat['-100123']).toContain('Бачила у інстаграм');
    expect(byChat['-100123']).not.toContain(AGENT_TURN_DEBUG_PREFIX);
    expect(byChat['-100123']).not.toContain('3380613918779953');
    expect(byChat['-100123']).not.toContain('Розмова:');

    expect(byChat['987654321']).toContain(AGENT_TURN_DEBUG_PREFIX);
    expect(byChat['987654321']).toContain('Claude spawns');
  });
});
