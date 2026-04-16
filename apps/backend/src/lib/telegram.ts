import { Bot } from 'grammy';
import { config } from '../config.js';

/**
 * Shared grammY Bot instance.
 *
 * Used by:
 * - telegram-bot.ts (PM2: SB-bot) — starts long polling, registers commands
 * - services/telegram-notify.ts (PM2: SB-api) — sends notifications via bot.api
 *
 * Both processes import this but only telegram-bot.ts calls bot.start().
 * grammY allows multiple Bot instances with the same token — only one
 * should do long polling.
 */
let _bot: Bot | undefined;

export function getBot(): Bot {
  if (!_bot) {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    _bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  }
  return _bot;
}

export function getManagerGroupId(): string {
  return config.TELEGRAM_MANAGER_GROUP_ID;
}
