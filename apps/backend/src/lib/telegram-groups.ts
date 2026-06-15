/**
 * Auto-discovered Telegram group/supergroup chat IDs for manager notifications.
 *
 * When the bot is added to any group, we persist its chat id and broadcast
 * handoff/order/brief alerts to every known group (plus the legacy
 * managerGroupId from Settings / .env when set).
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

/** All chat ids that should receive manager notifications. */
export async function getNotificationGroupIds(): Promise<string[]> {
  const { telegram } = await getIntegrationConfig();
  const ids = new Set<string>();

  if (telegram.managerGroupId) {
    ids.add(telegram.managerGroupId);
  }

  for (const id of await readStoredGroupIds()) {
    ids.add(id);
  }

  return [...ids];
}

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
