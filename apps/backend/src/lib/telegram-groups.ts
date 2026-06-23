/**
 * Telegram chat IDs for manager notifications (groups + authorized private DMs).
 *
 * Targets:
 * - legacy managerGroupId from Settings / .env
 * - auto-discovered groups when the bot is added to a group/supergroup
 * - private chat ids of admin users linked via /login (tgUserId on admin_users)
 */

import pino from 'pino';
import { prisma } from './prisma.js';
import { getIntegrationConfig } from './integration-config.js';

const log = pino({ name: 'telegram-groups' });
const SETTING_KEY = 'telegram_notification_groups';

let cache: { ids: string[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export function invalidateTelegramGroupsCache(): void {
  cache = null;
}

async function readStoredGroupIds(): Promise<string[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.ids;
  }

  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = row?.value;
  const ids = Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  cache = { ids, expiresAt: now + CACHE_TTL_MS };
  return ids;
}

/** Merge notification targets without duplicates. */
export function mergeNotificationChatIds(params: {
  managerGroupId?: string;
  storedGroupIds: string[];
  authorizedManagerChatIds: string[];
}): string[] {
  const ids = new Set<string>();

  const legacyGroupId = params.managerGroupId?.trim();
  if (legacyGroupId) ids.add(legacyGroupId);

  for (const id of params.storedGroupIds) {
    ids.add(id);
  }
  for (const id of params.authorizedManagerChatIds) {
    ids.add(id);
  }

  return [...ids];
}

async function readAuthorizedManagerChatIds(): Promise<string[]> {
  const rows = await prisma.adminUser.findMany({
    where: { tgUserId: { not: null } },
    select: { tgUserId: true },
  });

  return rows
    .map((row) => row.tgUserId?.trim())
    .filter((id): id is string => !!id);
}

/** All chat ids that should receive manager notifications. */
export async function getNotificationChatIds(): Promise<string[]> {
  const { telegram } = await getIntegrationConfig();
  return mergeNotificationChatIds({
    managerGroupId: telegram.managerGroupId,
    storedGroupIds: await readStoredGroupIds(),
    authorizedManagerChatIds: await readAuthorizedManagerChatIds(),
  });
}

/** @deprecated Use getNotificationChatIds */
export const getNotificationGroupIds = getNotificationChatIds;

export function isGroupChatType(type: string | undefined): boolean {
  return type === 'group' || type === 'supergroup';
}

export async function registerTelegramGroup(
  chatId: string | number,
  title?: string,
): Promise<void> {
  const id = String(chatId);
  const existing = await readStoredGroupIds();
  if (existing.includes(id)) return;

  const next = [...existing, id];
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as never },
    create: { key: SETTING_KEY, value: next as never },
  });
  invalidateTelegramGroupsCache();
  log.info({ chatId: id, title }, 'Registered Telegram notification group');
}

export async function unregisterTelegramGroup(chatId: string | number): Promise<void> {
  const id = String(chatId);
  const existing = await readStoredGroupIds();
  const next = existing.filter((groupId) => groupId !== id);
  if (next.length === existing.length) return;

  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as never },
    create: { key: SETTING_KEY, value: next as never },
  });
  invalidateTelegramGroupsCache();
  log.info({ chatId: id }, 'Unregistered Telegram notification group');
}
