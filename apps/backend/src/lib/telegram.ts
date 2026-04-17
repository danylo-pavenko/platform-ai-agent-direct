import { Bot } from 'grammy';
import { getIntegrationConfig } from './integration-config.js';

/**
 * Shared grammY Bot instance, lazily created from DB/env token.
 *
 * getBot() is async so it can read the token from the integration config
 * (DB with .env fallback). The instance is cached per token value and
 * recreated if the token changes.
 *
 * Used by:
 * - telegram-bot.ts (PM2: SB-bot) — starts long polling
 * - services/telegram-notify.ts (PM2: SB-api) — sends notifications
 */

let _bot: Bot | undefined;
let _botToken = '';

export async function getBot(): Promise<Bot> {
  const cfg = await getIntegrationConfig();
  const token = cfg.telegram.botToken;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }

  // Recreate if token changed
  if (!_bot || _botToken !== token) {
    _bot = new Bot(token);
    _botToken = token;
  }

  return _bot;
}

export async function getManagerGroupId(): Promise<string> {
  const cfg = await getIntegrationConfig();
  return cfg.telegram.managerGroupId;
}
