import { describe, expect, it, vi, beforeEach } from 'vitest';

const { findUnique, findFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    conversation: { findUnique },
    message: { findFirst },
  },
}));

import { isBotTurnStillValid } from './conversation-bot-guard.js';

describe('isBotTurnStillValid', () => {
  const turnStartedAt = new Date('2026-06-15T12:00:00Z');

  beforeEach(() => {
    findUnique.mockReset();
    findFirst.mockReset();
  });

  it('allows when conversation is bot and no manager message', async () => {
    findUnique.mockResolvedValue({ state: 'bot' });
    findFirst.mockResolvedValue(null);
    await expect(isBotTurnStillValid('conv-1', turnStartedAt)).resolves.toBe(true);
  });

  it('blocks when conversation is in handoff', async () => {
    findUnique.mockResolvedValue({ state: 'handoff' });
    findFirst.mockResolvedValue(null);
    await expect(isBotTurnStillValid('conv-1', turnStartedAt)).resolves.toBe(false);
  });

  it('blocks when manager replied during the turn', async () => {
    findUnique.mockResolvedValue({ state: 'bot' });
    findFirst.mockResolvedValue({ id: 'msg-1' });
    await expect(isBotTurnStillValid('conv-1', turnStartedAt)).resolves.toBe(false);
  });
});
