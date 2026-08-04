import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDefaultBranch, getIntegrationConfig, prismaFindFirst } = vi.hoisted(() => ({
  getDefaultBranch: vi.fn(),
  getIntegrationConfig: vi.fn(),
  prismaFindFirst: vi.fn(),
}));

vi.mock('./branches.js', () => ({ getDefaultBranch }));
vi.mock('../lib/integration-config.js', () => ({ getIntegrationConfig }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    branch: { findFirst: prismaFindFirst },
  },
}));

import { resolveBookingBranchCrmId } from './booking-branch.js';

describe('resolveBookingBranchCrmId', () => {
  beforeEach(() => {
    getDefaultBranch.mockReset();
    getIntegrationConfig.mockReset();
    prismaFindFirst.mockReset();
  });

  it('prefers conversation branch id', async () => {
    await expect(resolveBookingBranchCrmId('  conv-loc  ')).resolves.toBe('conv-loc');
    expect(getDefaultBranch).not.toHaveBeenCalled();
  });

  it('falls back to default branch then BeautyPro location', async () => {
    getDefaultBranch.mockResolvedValue(null);
    prismaFindFirst.mockResolvedValue(null);
    getIntegrationConfig.mockResolvedValue({
      beautypro: { defaultLocationId: 'bp-loc' },
    });
    await expect(resolveBookingBranchCrmId(null)).resolves.toBe('bp-loc');
  });
});
