import { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';

export const TELEGRAM_BOT_WAKE_KEY = 'telegram_bot_wake';

/** Default idle poll when no token is configured. */
export const TELEGRAM_BOT_IDLE_POLL_MS = 60_000;

/** Fast poll after admin saves Telegram settings. */
export const TELEGRAM_BOT_WAKE_POLL_MS = 3_000;

/** How long after a wake signal to use fast polling. */
export const TELEGRAM_BOT_WAKE_WINDOW_MS = 60_000;

/** How often the active bot session re-checks token changes. */
export const TELEGRAM_BOT_CONFIG_WATCH_MS = 30_000;

export async function bumpTelegramBotWake(): Promise<void> {
  const value = { at: Date.now() } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: TELEGRAM_BOT_WAKE_KEY },
    create: { key: TELEGRAM_BOT_WAKE_KEY, value },
    update: { value },
  });
}

export async function getTelegramBotWakeAt(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: TELEGRAM_BOT_WAKE_KEY } });
  if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) return 0;
  const at = (row.value as Record<string, unknown>).at;
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
}

export function resolveTelegramBotIdlePollMs(
  wakeAt: number,
  lastSeenWakeAt: number,
  now = Date.now(),
): number {
  const recentWake =
    wakeAt > lastSeenWakeAt && wakeAt > 0 && now - wakeAt < TELEGRAM_BOT_WAKE_WINDOW_MS;
  return recentWake ? TELEGRAM_BOT_WAKE_POLL_MS : TELEGRAM_BOT_IDLE_POLL_MS;
}
