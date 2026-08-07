import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDefaultBranch, getIntegrationConfig, prismaFindFirst, prismaFindUnique } = vi.hoisted(
  () => ({
    getDefaultBranch: vi.fn(),
    getIntegrationConfig: vi.fn(),
    prismaFindFirst: vi.fn(),
    prismaFindUnique: vi.fn(),
  }),
);

vi.mock('./branches.js', () => ({ getDefaultBranch }));
vi.mock('../lib/integration-config.js', () => ({ getIntegrationConfig }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    branch: { findFirst: prismaFindFirst, findUnique: prismaFindUnique },
  },
}));

import {
  resolveBookingBranchCrmId,
  resolveBookingBranchForAppointment,
} from './booking-branch.js';

describe('resolveBookingBranchCrmId', () => {
  beforeEach(() => {
    getDefaultBranch.mockReset();
    getIntegrationConfig.mockReset();
    prismaFindFirst.mockReset();
    prismaFindUnique.mockReset();
  });

  it('prefers conversation branch CRM id', async () => {
    prismaFindFirst.mockResolvedValue(null);
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

describe('resolveBookingBranchForAppointment', () => {
  beforeEach(() => {
    getDefaultBranch.mockReset();
    getIntegrationConfig.mockReset();
    prismaFindFirst.mockReset();
    prismaFindUnique.mockReset();
  });

  it('uses conversation local branch when it has CRM id', async () => {
    prismaFindUnique.mockResolvedValue({
      id: 'b1',
      crmExternalId: 'loc-1',
      displayName: 'Центр',
    });
    await expect(
      resolveBookingBranchForAppointment({ conversationBranchId: 'b1' }),
    ).resolves.toEqual({
      branchId: 'b1',
      crmExternalId: 'loc-1',
      displayName: 'Центр',
      source: 'conversation',
    });
  });

  it('falls back to default branch when conversation has no branch', async () => {
    getDefaultBranch.mockResolvedValue({
      id: 'def',
      crmExternalId: 'bp-default',
      displayName: 'Moxito',
    });
    await expect(
      resolveBookingBranchForAppointment({ conversationBranchId: null }),
    ).resolves.toEqual({
      branchId: 'def',
      crmExternalId: 'bp-default',
      displayName: 'Moxito',
      source: 'default',
    });
  });
});
