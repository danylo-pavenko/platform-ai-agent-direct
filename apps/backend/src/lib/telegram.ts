import { Bot } from 'grammy';
import { getIntegrationConfig } from './integration-config.js';
import { getPrimaryTelegramBot } from './telegram-bots.js';

/**
 * grammY Bot instances keyed by token.
 *
 * Used by:
 * - telegram-bot.ts (PM2) — long polling for primary (and optionally others)
 * - services/telegram-notify.ts — outbound notifications per bot token
 */

const _botsByToken = new Map<string, Bot>();

export function getBotWithToken(token: string): Bot {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error('Telegram bot token is empty');
  }

  let bot = _botsByToken.get(trimmed);
  if (!bot) {
    bot = new Bot(trimmed);
    _botsByToken.set(trimmed, bot);
  }
  return bot;
}

/** Primary / legacy bot (backward compatible). */
export async function getBot(): Promise<Bot> {
  const cfg = await getIntegrationConfig();
  const primary = getPrimaryTelegramBot(cfg.telegram);
  const token = primary?.botToken || cfg.telegram.botToken;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }

  return getBotWithToken(token);
}

export async function getManagerGroupId(): Promise<string> {
  const cfg = await getIntegrationConfig();
  const primary = getPrimaryTelegramBot(cfg.telegram);
  return primary?.managerGroupId || cfg.telegram.managerGroupId;
}
