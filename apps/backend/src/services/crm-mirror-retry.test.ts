import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, isCrmWriteEnabled, mirrorOrderToCrm } = vi.hoisted(() => ({
  prismaMock: {
    order: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  isCrmWriteEnabled: vi.fn(),
  mirrorOrderToCrm: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/crm-write.js', () => ({ isCrmWriteEnabled }));
vi.mock('./crm-sync.js', () => ({ mirrorOrderToCrm }));

import { retryPendingCrmMirrors } from './crm-mirror-retry.js';

describe('retryPendingCrmMirrors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips work when CRM writes are disabled', async () => {
    isCrmWriteEnabled.mockResolvedValue(false);
    const stats = await retryPendingCrmMirrors();
    expect(stats).toEqual({ attempted: 0, synced: 0, failed: 0 });
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it('never selects booking orders for the KeyCRM worker', async () => {
    isCrmWriteEnabled.mockResolvedValue(true);
    prismaMock.order.findMany.mockResolvedValue([]);

    await retryPendingCrmMirrors();

    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { not: 'booking' },
          keycrmOrderId: null,
        }),
      }),
    );
    expect(mirrorOrderToCrm).not.toHaveBeenCalled();
  });
});
