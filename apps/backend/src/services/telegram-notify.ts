import pino from 'pino';
import { InlineKeyboard } from 'grammy';
import { getBot } from '../lib/telegram.js';
import { getNotificationChatIds } from '../lib/telegram-groups.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { config } from '../config.js';
import { adminConversationUrl, adminSettingsUrl } from '../lib/admin-urls.js';

const log = pino({ name: 'telegram-notify' });

// ── HTML escaping ───────────────────────────────────────────────────────

function escapeHtml(text: string | null | undefined): string {
  const safe = text == null ? '' : String(text);
  return safe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPaymentMethodLabel(method: string): string {
  switch (method) {
    case 'card':
      return 'Онлайн (картка / WayForPay)';
    case 'transfer':
      return 'Банківський переказ';
    case 'cod':
      return 'Післяплата';
    default:
      return method;
  }
}

// ── Internal helper ─────────────────────────────────────────────────────

async function sendToManagerGroup(
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const { telegram } = await getIntegrationConfig();

  if (!telegram.botToken) {
    log.warn('Telegram bot token not configured - skipping notification');
    return;
  }

  const groupIds = await getNotificationChatIds();
  if (groupIds.length === 0) {
    log.warn(
      'No Telegram notification targets — /login in private chat with the bot or add it to a manager group',
    );
    return;
  }

  const bot = await getBot();
  const opts = {
    parse_mode: 'HTML' as const,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };

  let successCount = 0;
  await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        await bot.api.sendMessage(groupId, text, opts);
        successCount++;
      } catch (err) {
        log.error({ err, groupId }, 'Failed to send Telegram notification to group');
      }
    }),
  );

  if (successCount > 0) {
    log.info({ successCount, totalGroups: groupIds.length }, 'Telegram notification delivered');
  } else {
    log.warn({ totalGroups: groupIds.length }, 'Telegram notification failed for all groups');
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Daily alert when Claude CLI session is missing or expired.
 */
export async function notifyClaudeAuthRequired(params: {
  sessionExpired: boolean;
  binaryOk: boolean;
}): Promise<void> {
  const { sessionExpired, binaryOk } = params;
  const settingsUrl = adminSettingsUrl();

  const title = !binaryOk
    ? 'Claude недоступний на сервері'
    : sessionExpired
      ? 'Сесія Claude застаріла'
      : 'Потрібна авторизація Claude';

  const text = [
    `🔑 <b>${title}</b>`,
    ``,
    `AI-агент і мета-агент не відповідатимуть, доки не оновите сесію.`,
    ``,
    `<a href="${escapeHtml(settingsUrl)}">Адмінка → Налаштування → Claude</a>`,
  ].join('\n');

  await sendToManagerGroup(text);
}

/**
 * Sends a Telegram alert when Claude subscription usage crosses warning/exhausted thresholds.
 */
export async function notifyClaudeUsageLimit(params: {
  status: 'warning' | 'exhausted';
  worstPercent: number;
  buckets: Array<{ label: string; percentUsed: number; resetsAt: string }>;
  subscriptionType?: string | null;
  message: string;
}): Promise<void> {
  const { status, worstPercent, buckets, subscriptionType, message } = params;
  const icon = status === 'exhausted' ? '🛑' : '⚠️';
  const title =
    status === 'exhausted'
      ? 'Ліміт Claude вичерпано'
      : 'Ліміт Claude майже вичерпано';

  const bucketsBlock = [...buckets]
    .sort((a, b) => b.percentUsed - a.percentUsed)
    .map(
      (b) =>
        `• ${escapeHtml(b.label)}: <b>${b.percentUsed}%</b> (скинеться ${escapeHtml(b.resetsAt)})`,
    )
    .join('\n');

  const text = [
    `${icon} <b>${title}</b>`,
    ``,
    escapeHtml(message),
    subscriptionType ? `План: <code>${escapeHtml(subscriptionType)}</code>` : '',
    `Пікове використання: <b>${worstPercent}%</b>`,
    ``,
    `<b>Бакети:</b>`,
    bucketsBlock || '<i>(немає даних)</i>',
    ``,
    `Перевірте <code>claude -p '/usage'</code> на сервері або Налаштування → Claude ліміти.`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  await sendToManagerGroup(text);
}

/**
 * Sends an escalation card to the manager group when the bot
 * hands off a conversation to a human manager.
 */
export async function notifyHandoff(params: {
  conversationId: string;
  clientIgUserId: string;
  reason: string;
  lastMessages: Array<{ sender: string; text: string; isVoice?: boolean }>;
}): Promise<void> {
  const { conversationId, clientIgUserId, reason, lastMessages } = params;
  const shortId = conversationId.slice(0, 8);
  const adminUrl = adminConversationUrl(conversationId);

  const messagesBlock = lastMessages
    .map((m) => {
      const icon =
        m.sender === 'bot' ? '🤖 Бот' : m.isVoice ? '👤 Клієнт (🎤)' : '👤 Клієнт';
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
    messagesBlock || '<i>(немає тексту)</i>',
    ``,
    `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
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
    conversationId,
    clientIgUserId,
    items,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
  } = params;
  const shortId = orderId.slice(0, 8);
  const shortConv = conversationId.slice(0, 8);
  const adminUrl = adminConversationUrl(conversationId);

  const total = items.reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1),
    0,
  );

  const itemsBlock = items
    .map((item) => {
      const name = item.name?.trim() || 'Товар';
      const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
      const price = Number(item.price) || 0;
      const variant = item.variant ? ` (${escapeHtml(item.variant)})` : '';
      return `• ${escapeHtml(name)}${variant} × ${qty} - ${price} ₴`;
    })
    .join('\n');

  const text = [
    `📦 <b>Нове замовлення #${escapeHtml(shortId)}</b>`,
    ``,
    `Клієнт: IG @${escapeHtml(clientIgUserId)}`,
    `Розмова: <code>#${escapeHtml(shortConv)}</code>`,
    `Ім'я: ${escapeHtml(customerName)}`,
    `Телефон: ${escapeHtml(phone)}`,
    `Місто: ${escapeHtml(city)}`,
    `НП: ${escapeHtml(npBranch)}`,
    `Оплата: ${escapeHtml(formatPaymentMethodLabel(paymentMethod))}`,
    ``,
    `<b>Товари:</b>`,
    itemsBlock || '<i>(немає позицій)</i>',
    `<b>Разом: ${total} ₴</b>`,
    ``,
    `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('✅ Підтвердити', `approve:${orderId}`)
    .text('❌ Відхилити', `decline:${orderId}`);

  await sendToManagerGroup(text, keyboard);
}

/**
 * Sends a presale-brief card to the manager group when the leadgen agent
 * submits a brief for a new lead. Lightweight shape — full brief lives in
 * the DB + CRM; the notification is the "you have a warm lead" nudge.
 */
export async function notifyBrief(params: {
  briefId: string;
  conversationId: string;
  clientIgUserId: string;
  businessName?: string | null;
  niche?: string | null;
  services?: string[];
  budgetRange?: string | null;
  phone?: string | null;
  email?: string | null;
  preferredChannel?: string | null;
  priority?: string | null;
  completenessPct?: number | null;
}): Promise<void> {
  const {
    briefId,
    conversationId,
    clientIgUserId,
    businessName,
    niche,
    services,
    budgetRange,
    phone,
    email,
    preferredChannel,
    priority,
    completenessPct,
  } = params;
  const shortBrief = briefId.slice(0, 8);
  const shortConv = conversationId.slice(0, 8);

  const lines: string[] = [];
  lines.push(`📋 <b>Новий пресейл-бриф #${escapeHtml(shortBrief)}</b>`);
  lines.push('');
  lines.push(`Клієнт: IG @${escapeHtml(clientIgUserId)}`);
  lines.push(`Розмова: <code>#${escapeHtml(shortConv)}</code>`);
  if (priority) lines.push(`Пріоритет: ${escapeHtml(priority)}`);
  if (completenessPct != null) {
    lines.push(`Повнота брифу: ${completenessPct}%`);
  }
  lines.push('');
  if (businessName) lines.push(`Бізнес: ${escapeHtml(businessName)}`);
  if (niche) lines.push(`Ніша: ${escapeHtml(niche)}`);
  if (services && services.length > 0) {
    lines.push(`Послуги: ${services.map((s) => escapeHtml(s)).join(', ')}`);
  }
  if (budgetRange) lines.push(`Бюджет: ${escapeHtml(budgetRange)}`);
  if (phone) lines.push(`Телефон: ${escapeHtml(phone)}`);
  if (email) lines.push(`Email: ${escapeHtml(email)}`);
  if (preferredChannel) lines.push(`Канал: ${escapeHtml(preferredChannel)}`);

  const keyboard = new InlineKeyboard()
    .text('👤 Взяти', `takeover:${conversationId}`)
    .text('📌 Позначити hot', `brief_hot:${briefId}`);

  await sendToManagerGroup(lines.join('\n'), keyboard);
}

/**
 * Fallback alert when CRM write fails — the brief / order is already safe
 * in our DB, but the manager needs the full snapshot here so they can
 * re-enter the record in the CRM by hand if it stays down.
 */
export async function notifyCrmFallback(params: {
  kind: 'brief' | 'order';
  entityId: string;
  reason: string;
  snapshot: Array<{ label: string; value: string | number | null | undefined }>;
  clientIgUserId?: string | null;
}): Promise<void> {
  const { kind, entityId, reason, snapshot, clientIgUserId } = params;
  const shortId = entityId.slice(0, 8);
  const titleRu =
    kind === 'brief'
      ? `бриф #${escapeHtml(shortId)}`
      : `замовлення #${escapeHtml(shortId)}`;

  const lines: string[] = [];
  lines.push(`⚠️ <b>CRM недоступна — ${titleRu} не записано</b>`);
  lines.push(`<i>Переношу повний снепшот для ручного введення.</i>`);
  lines.push('');
  if (clientIgUserId) {
    lines.push(`Клієнт: IG @${escapeHtml(clientIgUserId)}`);
  }
  lines.push(`Причина: <code>${escapeHtml(reason)}</code>`);
  lines.push('');
  for (const { label, value } of snapshot) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}`);
  }

  await sendToManagerGroup(lines.join('\n'));
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
