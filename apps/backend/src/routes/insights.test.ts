import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  askClaude,
  buildInsightsSnapshot,
  executeInsightsToolCall,
} = vi.hoisted(() => ({
  askClaude: vi.fn(),
  buildInsightsSnapshot: vi.fn(),
  executeInsightsToolCall: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    CLAUDE_TEACH_TIMEOUT_MS: 600_000,
  },
}));
vi.mock('../services/claude.js', () => ({ askClaude }));
vi.mock('../services/insights-snapshot.js', () => ({
  buildInsightsSnapshot,
  parseInsightsPeriod: vi.fn(() => '7d'),
}));
vi.mock('../services/insights-tools.js', async () => {
  const actual = await vi.importActual<typeof import('../services/insights-tools.js')>(
    '../services/insights-tools.js',
  );
  return {
    ...actual,
    executeInsightsToolCall,
  };
});

import { buildInsightsSystemPrompt, insightsRoutes } from './insights.js';

describe('insights routes', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  beforeEach(() => {
    askClaude.mockReset();
    buildInsightsSnapshot.mockReset();
    executeInsightsToolCall.mockReset();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildUnauthorizedApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async (_request, reply) => {
      await reply.code(401).send({ error: 'Unauthorized' });
    });
    app.decorate('requireOwner', async () => {});
    await app.register(insightsRoutes, { prefix: '/insights' });
    return app;
  }

  async function buildAuthorizedApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async (request) => {
      (request as { user?: { id: string } }).user = { id: 'owner-1' };
    });
    app.decorate('requireOwner', async () => {});
    await app.register(insightsRoutes, { prefix: '/insights' });
    return app;
  }

  async function buildManagerApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async () => {});
    app.decorate('requireOwner', async (_request, reply) => {
      await reply.code(403).send({ error: 'Forbidden' });
    });
    await app.register(insightsRoutes, { prefix: '/insights' });
    return app;
  }

  it('rejects snapshot access without tenant JWT', async () => {
    const app = await buildUnauthorizedApp();
    const response = await app.inject({
      method: 'GET',
      url: '/insights/snapshot?period=7d',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects chat access without tenant JWT', async () => {
    const app = await buildUnauthorizedApp();
    const response = await app.inject({
      method: 'POST',
      url: '/insights/chat',
      payload: {
        period: '7d',
        messages: [{ role: 'user', content: 'Про що пишуть клієнти?' }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects snapshot access for non-owner roles', async () => {
    const app = await buildManagerApp();
    const response = await app.inject({
      method: 'GET',
      url: '/insights/snapshot?period=7d',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('sends business context, tools, and chat history through the insights channel', async () => {
    const snapshot = {
      generatedAt: '2026-07-17T06:00:00.000Z',
      period: '7d',
      periodLabel: 'за останні 7 днів',
      from: '2026-07-10T06:00:00.000Z',
      to: '2026-07-17T06:00:00.000Z',
      business: { brandName: 'Test Brand' },
      totalsAllTime: {
        conversations: 3,
        messages: 10,
        inboundMessages: 5,
        botReplies: 3,
        managerReplies: 2,
        clients: 3,
      },
    };
    buildInsightsSnapshot.mockResolvedValue(snapshot);
    askClaude.mockResolvedValue({ text: 'CRM готова до роботи.' });
    const app = await buildAuthorizedApp();

    const response = await app.inject({
      method: 'POST',
      url: '/insights/chat',
      payload: {
        period: '7d',
        messages: [
          { role: 'user', content: 'Що було раніше?' },
          { role: 'assistant', content: 'Огляд активності.' },
          { role: 'user', content: 'А що з CRM?' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reply: 'CRM готова до роботи.',
      snapshotAt: snapshot.generatedAt,
    });
    expect(askClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationHistory: [
          { role: 'user', content: 'Що було раніше?' },
          { role: 'assistant', content: 'Огляд активності.' },
        ],
        userMessage: 'А що з CRM?',
        systemPrompt: expect.stringContaining('Test Brand'),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'get_conversation' }),
          expect.objectContaining({ name: 'create_product_order' }),
        ]),
      }),
      expect.objectContaining({
        channel: 'insights',
        timeoutMs: 600_000,
      }),
    );
  });

  it('runs a tool round then returns the follow-up reply', async () => {
    const snapshot = {
      generatedAt: '2026-07-17T06:00:00.000Z',
      period: '7d',
      periodLabel: 'за останні 7 днів',
      from: '2026-07-10T06:00:00.000Z',
      to: '2026-07-17T06:00:00.000Z',
      business: { brandName: 'Test Brand' },
      totalsAllTime: {
        conversations: 1,
        messages: 2,
        inboundMessages: 1,
        botReplies: 0,
        managerReplies: 1,
        clients: 1,
      },
    };
    buildInsightsSnapshot.mockResolvedValue(snapshot);
    askClaude
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          {
            name: 'get_conversation',
            args: { conversation_id: 'a0712020-04d1-4863-8ad4-1370d6905921' },
          },
        ],
        sessionId: 'sess-1',
      })
      .mockResolvedValueOnce({ text: 'Ось чернетка замовлення.' });
    executeInsightsToolCall.mockResolvedValue(
      '[get_conversation] РЕЗУЛЬТАТ: {"id":"a0712020-04d1-4863-8ad4-1370d6905921"}',
    );

    const app = await buildAuthorizedApp();
    const response = await app.inject({
      method: 'POST',
      url: '/insights/chat',
      payload: {
        period: '7d',
        messages: [
          {
            role: 'user',
            content: 'Проаналізуй /conversations/a0712020-04d1-4863-8ad4-1370d6905921',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toBe('Ось чернетка замовлення.');
    expect(executeInsightsToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'get_conversation' }),
      expect.objectContaining({ ownerUserId: 'owner-1' }),
    );
    expect(askClaude).toHaveBeenCalledTimes(2);
  });

  it('instructs confirm-gated writes and conversation tools', () => {
    const prompt = buildInsightsSystemPrompt({
      business: { brandName: 'Test Brand' },
      period: '30d',
      periodLabel: 'за останні 30 днів',
      from: '2026-06-17T00:00:00.000Z',
      to: '2026-07-17T00:00:00.000Z',
      totalsAllTime: {
        conversations: 3,
        messages: 12,
        inboundMessages: 6,
        botReplies: 4,
        managerReplies: 2,
        clients: 3,
      },
      conversations: { active: 0 },
      messages: { total: 0 },
      clients: { total: 3, active: 0 },
    } as Parameters<typeof buildInsightsSystemPrompt>[0]);

    expect(prompt).toContain('Чітко відділяй факти');
    expect(prompt).toContain('Ніколи не виводь');
    expect(prompt).toContain('[Налаштування](/settings)');
    expect(prompt).toContain('[CRM-поля](/crm-fields)');
    expect(prompt).toContain('[Замовлення](/orders)');
    expect(prompt).toContain('totalsAllTime');
    expect(prompt).toContain('recentAll');
    expect(prompt).toContain('Усього в базі зараз: 3 діалогів');
    expect(prompt).toContain('<platform_capabilities>');
    expect(prompt).toContain('get_conversation');
    expect(prompt).toContain('confirm=true');
    expect(prompt).toContain('Ніколи не надсилай повідомлення клієнту в Instagram');
    expect(prompt).toContain('Не вигадуй tools');
  });
});
