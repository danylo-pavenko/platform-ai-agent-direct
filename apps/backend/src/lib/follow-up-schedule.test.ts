import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  findUnique,
  updateMany,
  create,
  findMany,
  update,
  transaction,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: { FOLLOW_UP_JOB_ENABLED: true },
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    conversation: { findUnique },
    followUpJob: { updateMany, create, findMany, update },
    $transaction: transaction,
  },
}));

vi.mock('./follow-up-config.js', () => ({
  getFollowUpConfig: vi.fn(async () => ({ enabled: true, delayHours: 18 })),
  invalidateFollowUpConfigCache: vi.fn(),
  normalizeFollowUpConfig: (raw: { enabled?: boolean; delayHours?: number }) => ({
    enabled: raw?.enabled === true,
    delayHours:
      typeof raw?.delayHours === 'number' && Number.isFinite(raw.delayHours)
        ? Math.max(1, Math.min(24, Math.floor(raw.delayHours)))
        : 18,
  }),
}));

import {
  cancelPendingFollowUps,
  scheduleFollowUpAfterBotOutbound,
  reschedulePendingFollowUpsForDelay,
  onFollowUpConfigSaved,
} from './follow-up-schedule.js';
import { getFollowUpConfig } from './follow-up-config.js';

describe('follow-up-schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return arg({
          followUpJob: { updateMany, create },
        });
      }
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return undefined;
    });
    updateMany.mockResolvedValue({ count: 1 });
    create.mockResolvedValue({ id: 'job-1' });
    update.mockResolvedValue({});
  });

  it('cancelPendingFollowUps updates pending rows', async () => {
    updateMany.mockResolvedValue({ count: 2 });
    const n = await cancelPendingFollowUps('conv-1', 'client_inbound');
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1', status: 'pending' },
      data: {
        status: 'cancelled',
        lastError: 'client_inbound',
      },
    });
  });

  it('scheduleFollowUpAfterBotOutbound creates pending job with runAt = now+delay', async () => {
    findUnique.mockResolvedValue({
      id: 'conv-1',
      state: 'bot',
      channel: 'ig',
      followUpSentAt: null,
    });
    const from = new Date('2026-07-29T10:00:00Z');
    await scheduleFollowUpAfterBotOutbound('conv-1', from);

    expect(updateMany).toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: {
        conversationId: 'conv-1',
        runAt: new Date('2026-07-30T04:00:00.000Z'),
        scheduledFrom: from,
        status: 'pending',
      },
    });
  });

  it('scheduleFollowUpAfterBotOutbound noops when already sent this cycle', async () => {
    findUnique.mockResolvedValue({
      id: 'conv-1',
      state: 'bot',
      channel: 'ig',
      followUpSentAt: new Date(),
    });
    await scheduleFollowUpAfterBotOutbound('conv-1');
    expect(create).not.toHaveBeenCalled();
  });

  it('scheduleFollowUpAfterBotOutbound noops when follow-up disabled', async () => {
    vi.mocked(getFollowUpConfig).mockResolvedValueOnce({
      enabled: false,
      delayHours: 18,
    });
    await scheduleFollowUpAfterBotOutbound('conv-1');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reschedulePendingFollowUpsForDelay recomputes runAt from scheduledFrom', async () => {
    const from = new Date('2026-07-29T10:00:00Z');
    findMany.mockResolvedValue([{ id: 'j1', scheduledFrom: from }]);
    update.mockResolvedValue({});

    const n = await reschedulePendingFollowUpsForDelay(12);
    expect(n).toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { runAt: new Date(from.getTime() + 12 * 60 * 60_000) },
    });
  });

  it('onFollowUpConfigSaved cancels pending when disabled', async () => {
    updateMany.mockResolvedValue({ count: 3 });
    await onFollowUpConfigSaved({ enabled: true, delayHours: 18 }, {
      enabled: false,
      delayHours: 18,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      data: { status: 'cancelled', lastError: 'follow_up_disabled' },
    });
  });
});
