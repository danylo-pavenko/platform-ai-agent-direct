import pino from 'pino';
import { InlineKeyboard } from 'grammy';
import { getBot, getManagerGroupId } from '../lib/telegram.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { config } from '../config.js';

const log = pino({ name: 'telegram-notify' });

// ── HTML escaping ───────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Internal helper ─────────────────────────────────────────────────────

async function sendToManagerGroup(
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const { telegram } = await getIntegrationConfig();
  const groupId = await getManagerGroupId();

  if (!telegram.botToken || !groupId) {
    log.warn('Telegram bot token or manager group ID not configured - skipping notification');
    return;
  }

  try {
    const bot = await getBot();
    await bot.api.sendMessage(groupId, text, {
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    log.error({ err }, 'Failed to send Telegram notification');
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Sends an escalation card to the manager group when the bot
 * hands off a conversation to a human manager.
 */
export async function notifyHandoff(params: {
  conversationId: string;
  clientIgUserId: string;
  reason: string;
  lastMessages: Array<{ sender: string; text: string }>;
}): Promise<void> {
  const { conversationId, clientIgUserId, reason, lastMessages } = params;
  const shortId = conversationId.slice(0, 8);

  const messagesBlock = lastMessages
    .map((m) => {
      const icon = m.sender === 'bot' ? '🤖 Бот' : '👤 Клієнт';
      return `${icon}: ${escapeHtml(m.text)}`;
    })
    .join('\n');

  const text = [
    `🔔 <b>Ескалація до менеджера</b>`,
    ``,
    `Клієнт: IG @${escapeHtml(clientIgUserId)}`,
    `Розмова: <code>#${escapeHtml(shortId)}</code>`,
    `Причина: ${escapeHtml(reason)}`,
    ``,
    `<b>Останні повідомлення:</b>`,
    messagesBlock,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('👤 Взяти', `takeover:${conversationId}`)
    .text('🤖 Повернути боту', `return:${conversationId}`);

  await sendToManagerGroup(text, keyboard);
}

/**
 * Sends an order card to the manager group when a new order is created.
 */
export async function notifyOrder(params: {
  orderId: string;
  conversationId: string;
  clientIgUserId: string;
  items: Array<{ name: string; variant?: string; price: number; qty: number }>;
  customerName: string;
  phone: string;
  city: string;
  npBranch: string;
  paymentMethod: string;
}): Promise<void> {
  const {
    orderId,
    clientIgUserId,
    items,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
  } = params;
  const shortId = orderId.slice(0, 8);

  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  const itemsBlock = items
    .map((item) => {
      const variant = item.variant ? ` (${escapeHtml(item.variant)})` : '';
      return `• ${escapeHtml(item.name)}${variant} × ${item.qty} - ${item.price} ₴`;
    })
    .join('\n');

  const text = [
    `📦 <b>Нове замовлення #${escapeHtml(shortId)}</b>`,
    ``,
    `Клієнт: IG @${escapeHtml(clientIgUserId)}`,
    `Ім'я: ${escapeHtml(customerName)}`,
    `Телефон: ${escapeHtml(phone)}`,
    `Місто: ${escapeHtml(city)}`,
    `НП: ${escapeHtml(npBranch)}`,
    `Оплата: ${escapeHtml(paymentMethod)}`,
    ``,
    `<b>Товари:</b>`,
    itemsBlock,
    `<b>Разом: ${total} ₴</b>`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('✅ Підтвердити', `approve:${orderId}`)
    .text('❌ Відхилити', `decline:${orderId}`);

  await sendToManagerGroup(text, keyboard);
}

/**
 * Sends a technical error alert to the manager group.
 */
export async function notifyError(error: Error | string): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error);
  const truncated =
    message.length > 500 ? message.slice(0, 500) + '…' : message;

  const text = [
    `⚠️ <b>Помилка [${escapeHtml(config.INSTANCE_ID)}]</b>`,
    ``,
    `<code>${escapeHtml(truncated)}</code>`,
  ].join('\n');

  await sendToManagerGroup(text);
}

/**
 * Sends a token expiry warning to the manager group.
 */
export async function notifyTokenExpiry(daysLeft: number): Promise<void> {
  const text = [
    `⏰ <b>IG Token Expiry Warning</b>`,
    ``,
    `Токен Instagram закінчується через <b>${daysLeft}</b> днів.`,
    `Оновіть токен у .env та перезапустіть сервер.`,
  ].join('\n');

  await sendToManagerGroup(text);
}
