import { prisma } from './prisma.js';
import { formatAdminLabel } from './admin-user.js';

export type RedeemTelegramLinkResult =
  | { ok: true; user: { id: string; username: string; displayName: string | null; tgUsername: string | null } }
  | { ok: false; error: string; code: 'INVALID' | 'EXPIRED' | 'USED' | 'INACTIVE' | 'TG_TAKEN' };

/**
 * Redeem a one-time /link code and bind Telegram identity to the AdminUser.
 */
export async function redeemTelegramLinkCode(params: {
  code: string;
  tgUserId: string;
  tgUsername: string | null;
}): Promise<RedeemTelegramLinkResult> {
  const normalized = params.code.trim().toUpperCase();
  if (!normalized) {
    return { ok: false, error: 'Вкажіть код.', code: 'INVALID' };
  }

  const row = await prisma.adminTelegramLinkCode.findUnique({
    where: { code: normalized },
    include: { adminUser: true },
  });

  if (!row) {
    return { ok: false, error: 'Невірний код.', code: 'INVALID' };
  }
  if (row.usedAt) {
    return { ok: false, error: 'Цей код уже використано.', code: 'USED' };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'Код прострочено. Попросіть новий у адміна.', code: 'EXPIRED' };
  }
  if (!row.adminUser.isActive) {
    return { ok: false, error: 'Обліковий запис вимкнено.', code: 'INACTIVE' };
  }

  const tgTaken = await prisma.adminUser.findFirst({
    where: {
      tgUserId: params.tgUserId,
      NOT: { id: row.adminUserId },
    },
  });
  if (tgTaken) {
    return {
      ok: false,
      error: 'Цей Telegram уже привʼязаний до іншого користувача. Спочатку /unlink там.',
      code: 'TG_TAKEN',
    };
  }

  const tgUsername = params.tgUsername?.trim().replace(/^@/, '') || null;

  const [, user] = await prisma.$transaction([
    prisma.adminTelegramLinkCode.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    }),
    prisma.adminUser.update({
      where: { id: row.adminUserId },
      data: {
        tgUserId: params.tgUserId,
        tgUsername,
      },
    }),
  ]);

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      tgUsername: user.tgUsername,
    },
  };
}

export async function findActiveManagerByTgId(tgUserId: number | string) {
  return prisma.adminUser.findFirst({
    where: {
      tgUserId: String(tgUserId),
      isActive: true,
    },
  });
}

export async function unlinkTelegramFromManager(tgUserId: number | string) {
  const user = await prisma.adminUser.findFirst({
    where: { tgUserId: String(tgUserId) },
  });
  if (!user) return null;
  return prisma.adminUser.update({
    where: { id: user.id },
    data: { tgUserId: null, tgUsername: null },
  });
}

export function managerLabelFromUser(user: {
  displayName?: string | null;
  tgUsername?: string | null;
  username: string;
}): string {
  return formatAdminLabel(user);
}
