import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { askClaude, buildInsightsSnapshot } = vi.hoisted(() => ({
  askClaude: vi.fn(),
  buildInsightsSnapshot: vi.fn(),
}));

vi.mock('../services/claude.js', () => ({ askClaude }));
vi.mock('../services/insights-snapshot.js', () => ({
  buildInsightsSnapshot,
  parseInsightsPeriod: vi.fn(() => '7d'),
}));

import { buildInsightsSystemPrompt, insightsRoutes } from './insights.js';

describe('insights routes', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  beforeEach(() => {
    askClaude.mockReset();
    buildInsightsSnapshot.mockReset();
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
    await app.register(insightsRoutes, { prefix: '/insights' });
    return app;
  }

  async function buildAuthorizedApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async () => {});
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

  it('sends business context and chat history through the insights channel', async () => {
    const snapshot = {
      generatedAt: '2026-07-17T06:00:00.000Z',
      period: '7d',
      from: '2026-07-10T06:00:00.000Z',
      to: '2026-07-17T06:00:00.000Z',
      business: { brandName: 'Test Brand' },
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
      }),
      { channel: 'insights' },
    );
  });

  it('instructs the assistant to separate facts, advice, and safe actions', () => {
    const prompt = buildInsightsSystemPrompt({
      business: { brandName: 'Test Brand' },
      period: '30d',
      from: '2026-06-17T00:00:00.000Z',
      to: '2026-07-17T00:00:00.000Z',
    } as Parameters<typeof buildInsightsSystemPrompt>[0]);

    expect(prompt).toContain('Чітко відділяй факти');
    expect(prompt).toContain('Ніколи не виводь');
    expect(prompt).toContain('[Налаштування](/settings)');
    expect(prompt).toContain('[CRM-поля](/crm-fields)');
  });
});
