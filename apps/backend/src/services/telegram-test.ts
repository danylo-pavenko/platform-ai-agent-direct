import { Bot } from 'grammy';
import pino from 'pino';
import { config } from '../config.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { sanitizeIntegrationSecret } from '../lib/integration-secrets.js';
import { getNotificationChatIds } from '../lib/telegram-groups.js';

const log = pino({ name: 'telegram-test' });

export type TelegramTestVariant = 'connectivity' | 'meta_agent';

export interface TelegramTestResult {
  ok: boolean;
  variant: TelegramTestVariant;
  sentTo: string[];
  errors: Array<{ chatId: string; message: string }>;
  message: string;
}

function buildTestMessage(variant: TelegramTestVariant): string {
  const brand = config.BRAND_NAME;
  if (variant === 'meta_agent') {
    return [
      `🤖 <b>Тест мета-агента — ${brand}</b>`,
      '',
      'Приклад сповіщення від редактора системного промпта:',
      '',
      '<b>ПОЯСНЕННЯ:</b> Тестове повідомлення — канал Telegram для адмін-сповіщень працює.',
      '',
      '<i>Якщо ви бачите це — бот може доставляти алерти менеджерам (ескалації, замовлення, ліміти Claude).</i>',
    ].join('\n');
  }

  return [
    `🧪 <b>Тест Telegram — ${brand}</b>`,
    '',
    'Бот підключено і може надсилати повідомлення в цей чат.',
    `Інстанс: <code>${config.INSTANCE_ID}</code>`,
  ].join('\n');
}

async function resolveBotToken(override?: string): Promise<string> {
  const fromBody = sanitizeIntegrationSecret(override);
  if (fromBody) return fromBody;

  const { telegram } = await getIntegrationConfig();
  if (telegram.botToken) return telegram.botToken;

  throw new Error('Bot Token не налаштовано — вкажіть токен і збережіть налаштування');
}

async function resolveTargetChatIds(managerGroupIdOverride?: string): Promise<string[]> {
  const override = typeof managerGroupIdOverride === 'string' ? managerGroupIdOverride.trim() : '';
  if (override) return [override];

  return getNotificationChatIds();
}

/**
 * Sends a test HTML message to manager notification group(s).
 * Optional `botToken` / `managerGroupId` test unsaved Settings values.
 */
export async function sendTelegramTestMessage(params: {
  variant?: TelegramTestVariant;
  botToken?: string;
  managerGroupId?: string;
}): Promise<TelegramTestResult> {
  const variant = params.variant ?? 'connectivity';
  const token = await resolveBotToken(params.botToken);
  const chatIds = await resolveTargetChatIds(params.managerGroupId);

  if (chatIds.length === 0) {
    return {
      ok: false,
      variant,
      sentTo: [],
      errors: [],
      message:
        'Немає одержувачів. Напишіть боту в особисті повідомлення /login <пароль> або додайте бота в групу менеджерів.',
    };
  }

  const bot = new Bot(token);
  const text = buildTestMessage(variant);
  const sentTo: string[] = [];
  const errors: Array<{ chatId: string; message: string }> = [];

  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        sentTo.push(chatId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err, chatId, variant }, 'Telegram test message failed');
        errors.push({ chatId, message });
      }
    }),
  );

  const ok = sentTo.length > 0;
  let message: string;
  if (ok && errors.length === 0) {
    message =
      variant === 'meta_agent'
        ? `Тестове сповіщення мета-агента надіслано (${sentTo.length} груп).`
        : `Тестове повідомлення надіслано (${sentTo.length} груп).`;
  } else if (ok) {
    message = `Надіслано в ${sentTo.length} з ${chatIds.length} груп. Перевірте помилки.`;
  } else {
    message = errors[0]?.message ?? 'Не вдалося надіслати тестове повідомлення';
  }

  return { ok, variant, sentTo, errors, message };
}
