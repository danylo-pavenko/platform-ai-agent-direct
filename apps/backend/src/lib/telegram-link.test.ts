import { describe, expect, it, vi, beforeEach } from 'vitest';

const { findUnique, findFirst, update, transaction, linkCodeUpdate } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  linkCodeUpdate: vi.fn(),
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    adminTelegramLinkCode: {
      findUnique,
      update: linkCodeUpdate,
    },
    adminUser: {
      findFirst,
      update,
    },
    $transaction: transaction,
  },
}));

import { redeemTelegramLinkCode } from './telegram-link.js';

describe('redeemTelegramLinkCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid / missing code', async () => {
    findUnique.mockResolvedValue(null);
    const result = await redeemTelegramLinkCode({
      code: 'NOPE',
      tgUserId: '1',
      tgUsername: null,
    });
    expect(result).toEqual({
      ok: false,
      error: 'Невірний код.',
      code: 'INVALID',
    });
  });

  it('rejects expired code', async () => {
    findUnique.mockResolvedValue({
      id: 'c1',
      code: 'ABCD1234',
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      adminUserId: 'u1',
      adminUser: { isActive: true },
    });
    const result = await redeemTelegramLinkCode({
      code: 'abcd1234',
      tgUserId: '99',
      tgUsername: 'mgr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EXPIRED');
  });

  it('rejects when Telegram already linked to another user', async () => {
    findUnique.mockResolvedValue({
      id: 'c1',
      code: 'ABCD1234',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      adminUserId: 'u1',
      adminUser: { isActive: true },
    });
    findFirst.mockResolvedValue({ id: 'other' });
    const result = await redeemTelegramLinkCode({
      code: 'ABCD1234',
      tgUserId: '99',
      tgUsername: 'mgr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TG_TAKEN');
  });

  it('binds tg identity and marks code used', async () => {
    findUnique.mockResolvedValue({
      id: 'c1',
      code: 'ABCD1234',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      adminUserId: 'u1',
      adminUser: { isActive: true },
    });
    findFirst.mockResolvedValue(null);
    const updatedUser = {
      id: 'u1',
      username: 'manager_x',
      displayName: 'Катя',
      tgUsername: 'katya',
    };
    transaction.mockResolvedValue([{}, updatedUser]);

    const result = await redeemTelegramLinkCode({
      code: 'abcd1234',
      tgUserId: '99',
      tgUsername: '@katya',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.displayName).toBe('Катя');
      expect(result.user.tgUsername).toBe('katya');
    }
    expect(transaction).toHaveBeenCalled();
  });
});
