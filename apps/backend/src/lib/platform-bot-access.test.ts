import { describe, expect, it, vi, beforeEach } from 'vitest';

const { checkPlatformAccess, findFirst } = vi.hoisted(() => ({
  checkPlatformAccess: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('./platform-access.js', () => ({
  checkPlatformAccess,
  PLATFORM_GRANDFATHER_DAYS: 30,
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    message: { findFirst },
  },
}));

import { evaluateBotAccessForClient } from './platform-bot-access.js';

const NOW = new Date('2026-06-23T12:00:00Z');

describe('evaluateBotAccessForClient', () => {
  beforeEach(() => {
    checkPlatformAccess.mockReset();
    findFirst.mockReset();
  });

  it('allows when platform access is active', async () => {
    checkPlatformAccess.mockResolvedValue({ allowed: true, reason: null, accessExpiresAt: null });
    await expect(evaluateBotAccessForClient('client-1', NOW)).resolves.toEqual({ allow: true });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('denies when suspended', async () => {
    checkPlatformAccess.mockResolvedValue({ allowed: false, reason: 'suspended', accessExpiresAt: null });
    await expect(evaluateBotAccessForClient('client-1', NOW)).resolves.toEqual({
      allow: false,
      reason: 'suspended',
    });
  });

  it('denies expired with no prior IG messages (new client)', async () => {
    checkPlatformAccess.mockResolvedValue({
      allowed: false,
      reason: 'expired',
      accessExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    findFirst.mockResolvedValue(null);
    await expect(evaluateBotAccessForClient('client-1', NOW)).resolves.toEqual({
      allow: false,
      reason: 'expired_new',
    });
  });

  it('denies expired when last activity older than grandfather window', async () => {
    checkPlatformAccess.mockResolvedValue({
      allowed: false,
      reason: 'expired',
      accessExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    findFirst.mockResolvedValue({ createdAt: new Date('2026-05-01T12:00:00Z') });
    await expect(evaluateBotAccessForClient('client-1', NOW)).resolves.toEqual({
      allow: false,
      reason: 'expired_stale',
    });
  });

  it('allows expired when last activity within grandfather window', async () => {
    checkPlatformAccess.mockResolvedValue({
      allowed: false,
      reason: 'expired',
      accessExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    findFirst.mockResolvedValue({ createdAt: new Date('2026-06-10T12:00:00Z') });
    await expect(evaluateBotAccessForClient('client-1', NOW)).resolves.toEqual({ allow: true });
  });
});
