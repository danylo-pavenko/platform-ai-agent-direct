import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    order: { findMany: vi.fn() },
    appointment: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));

import { loadClaudeHistoryMessages } from './claude-history-load.js';

describe('loadClaudeHistoryMessages', () => {
  beforeEach(() => {
    prismaMock.order.findMany.mockReset();
    prismaMock.appointment.findMany.mockReset();
    prismaMock.message.findMany.mockReset();
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.appointment.findMany.mockResolvedValue([]);
  });

  it('loads from conversation start when the thread began today', async () => {
    const created = new Date('2026-09-19T08:00:00.000Z');
    prismaMock.message.findMany.mockResolvedValue([
      {
        id: '2',
        direction: 'in',
        text: 'друге',
        sender: 'client',
        createdAt: new Date('2026-09-19T09:00:00.000Z'),
        igMessageId: 'm2',
        igContext: null,
      },
      {
        id: '1',
        direction: 'out',
        text: 'перше',
        sender: 'bot',
        createdAt: new Date('2026-09-19T08:30:00.000Z'),
        igMessageId: 'm1',
        igContext: null,
      },
    ]);

    const { rows, meta } = await loadClaudeHistoryMessages({
      conversationId: 'c1',
      conversationCreatedAt: created,
      timeZone: 'Europe/Kyiv',
      now: new Date('2026-09-19T12:00:00.000Z'),
    });

    expect(meta.reason).toBe('conversation_start');
    expect(meta.inclusive).toBe(true);
    expect(prismaMock.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: created },
        }),
      }),
    );
    expect(rows.map((r) => r.text)).toEqual(['перше', 'друге']);
  });

  it('starts after the last completed non-booking order today', async () => {
    const created = new Date('2026-09-19T07:00:00.000Z');
    const orderAt = new Date('2026-09-19T10:00:00.000Z');
    prismaMock.order.findMany.mockResolvedValue([
      { createdAt: orderAt, submittedToManagerAt: orderAt },
    ]);
    prismaMock.message.findMany.mockResolvedValue([]);

    const { meta } = await loadClaudeHistoryMessages({
      conversationId: 'c1',
      conversationCreatedAt: created,
      timeZone: 'Europe/Kyiv',
      now: new Date('2026-09-19T12:00:00.000Z'),
    });

    expect(meta.reason).toBe('after_order');
    expect(meta.inclusive).toBe(false);
    expect(prismaMock.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gt: orderAt },
        }),
      }),
    );
  });
});
