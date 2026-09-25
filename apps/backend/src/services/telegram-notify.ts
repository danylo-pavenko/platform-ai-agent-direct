import pino from 'pino';
import { InlineKeyboard } from 'grammy';
import { getBotWithToken } from '../lib/telegram.js';
import {
  filterChatIdsForAudience,
  getNotificationChatIdsForBot,
  type TelegramNotifyAudience,
} from '../lib/telegram-groups.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { config } from '../config.js';
import { adminConversationUrl, adminSettingsUrl } from '../lib/admin-urls.js';
import {
  resolveTelegramBotsForChannel,
  type TelegramNotifyChannel,
} from '../lib/telegram-bots.js';
import {
  formatTelegramClientLabel,
  isHandoffServiceNote,
  selectHandoffServiceNotes,
  selectManagerFacingHandoffLines,
  unwrapCoalescePreamble,
  type TelegramClientRef,
} from '../lib/handoff-format.js';
import { isSyntheticReactionText } from '../lib/ig-reaction-policy.js';

const log = pino({ name: 'telegram-notify' });

const MISSING_TOKEN_LOG_INTERVAL_MS = 15 * 60_000;
let lastMissingTokenLogAt = 0;

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

function lastMessagesBlock(
  lastMessages: Array<{ sender: string; text: string; isVoice?: boolean }>,
): string {
  if (lastMessages.length === 0) return '<i>(немає тексту)</i>';
  return lastMessages
    .map((m) => {
      const icon =
        m.sender === 'bot'
          ? '🤖 Бот'
          : m.sender === 'system'
            ? '🛠 Сервіс'
            : m.isVoice
              ? '👤 Клієнт (🎤)'
              : '👤 Клієнт';
      return `${icon}: ${escapeHtml(m.text)}`;
    })
    .join('\n');
}

function buildHandoffCard(params: {
  reason: string;
  clientLabel: string;
  lastMessages: Array<{ sender: string; text: string; isVoice?: boolean }>;
  adminUrl: string;
}): string {
  return [
    `🔔 <b>Ескалація до менеджера</b>`,
    ``,
    `Клієнт: ${escapeHtml(params.clientLabel)}`,
    `Причина: ${escapeHtml(params.reason)}`,
    ``,
    `<b>Останні повідомлення:</b>`,
    lastMessagesBlock(params.lastMessages),
    ``,
    `<a href="${escapeHtml(params.adminUrl)}">Відкрити діалог в адмінці</a>`,
  ].join('\n');
}

function clientLabelFrom(params: TelegramClientRef): string {
  return formatTelegramClientLabel(params);
}

// ── Internal helper ─────────────────────────────────────────────────────

const TELEGRAM_TEXT_MAX = 3900;

function truncateTelegramText(text: string, max = TELEGRAM_TEXT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function sendToManagerGroup(
  text: string,
  keyboard?: InlineKeyboard,
  channel: TelegramNotifyChannel = 'ops',
  audience: TelegramNotifyAudience = 'all',
): Promise<void> {
  const { telegram } = await getIntegrationConfig();
  const bots = resolveTelegramBotsForChannel(telegram, channel);

  if (bots.length === 0) {
    const now = Date.now();
    if (now - lastMissingTokenLogAt >= MISSING_TOKEN_LOG_INTERVAL_MS) {
      log.debug({ channel }, 'Telegram bot token not configured — skipping notification');
      lastMissingTokenLogAt = now;
    }
    return;
  }

  // Inline keyboards must be handled by a polled bot — attach to primary
  // when present among recipients, otherwise the first matched bot.
  const keyboardBotId =
    bots.find((b) => b.isPrimary)?.id ?? bots[0]?.id ?? null;

  let totalSuccess = 0;
  let totalTargets = 0;

  for (const botCfg of bots) {
    const rawIds = await getNotificationChatIdsForBot(botCfg);
    const groupIds = filterChatIdsForAudience(rawIds, audience);
    if (groupIds.length === 0) {
      if (rawIds.length === 0) {
        log.warn(
          { botId: botCfg.id, label: botCfg.label, channel },
          'No Telegram targets for bot — /login or set Manager Group ID',
        );
      }
      continue;
    }

    const useKeyboard = Boolean(keyboard) && botCfg.id === keyboardBotId;
    const bot = getBotWithToken(botCfg.botToken);
    const opts = {
      parse_mode: 'HTML' as const,
      ...(useKeyboard && keyboard ? { reply_markup: keyboard } : {}),
    };

    totalTargets += groupIds.length;
    await Promise.all(
      groupIds.map(async (groupId) => {
        try {
          await bot.api.sendMessage(groupId, text, opts);
          totalSuccess++;
        } catch (err) {
          log.error(
            { err, groupId, botId: botCfg.id, channel, audience },
            'Failed to send Telegram notification',
          );
        }
      }),
    );
  }

  if (totalSuccess > 0) {
    log.info(
      {
        successCount: totalSuccess,
        totalTargets,
        channel,
        audience,
        bots: bots.map((b) => b.id),
      },
      'Telegram notification delivered',
    );
  } else if (totalTargets > 0) {
    log.warn({ totalTargets, channel }, 'Telegram notification failed for all targets');
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

  await sendToManagerGroup(text, undefined, 'auth');
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
    `Перевірте ліміти в Налаштування → Claude або кеш <code>~/.claude.json</code> (cachedUsageUtilization).`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  await sendToManagerGroup(text, undefined, 'auth');
}

/**
 * Sends an escalation card to the manager group when the bot
 * hands off a conversation to a human manager.
 */
export async function notifyHandoff(params: {
  conversationId: string;
  clientIgUserId: string;
  clientDisplayName?: string | null;
  clientIgUsername?: string | null;
  reason: string;
  lastMessages: Array<{ sender: string; text: string; isVoice?: boolean }>;
}): Promise<void> {
  const { conversationId, reason, lastMessages } = params;
  const adminUrl = adminConversationUrl(conversationId);
  const clientLabel = clientLabelFrom({
    displayName: params.clientDisplayName,
    igUsername: params.clientIgUsername,
    igUserId: params.clientIgUserId,
  });

  const lines = lastMessages.map((m) => ({
    sender: m.sender,
    text: m.text,
    isVoice: Boolean(m.isVoice),
  }));
  const managerLines = selectManagerFacingHandoffLines(lines);
  const serviceNotes = selectHandoffServiceNotes(lines);

  const keyboard = new InlineKeyboard()
    .text('👤 Взяти', `takeover:${conversationId}`)
    .text('🤖 Повернути боту', `return:${conversationId}`);

  const groupText = truncateTelegramText(
    buildHandoffCard({
      reason,
      clientLabel,
      lastMessages: managerLines,
      adminUrl,
    }),
  );

  if (serviceNotes.length === 0) {
    await sendToManagerGroup(groupText, keyboard, 'handoff');
    return;
  }

  const verboseText = truncateTelegramText(
    buildHandoffCard({
      reason,
      clientLabel,
      lastMessages: [...managerLines, ...serviceNotes],
      adminUrl,
    }),
  );

  await sendToManagerGroup(groupText, keyboard, 'handoff', 'groups');
  await sendToManagerGroup(verboseText, keyboard, 'handoff', 'private');
}

/**
 * Admin-only agent/vision dump. Private chat with the bot (`/login`), never
 * groups the bot was added to.
 */
export async function notifyAgentTurnDebug(params: {
  conversationId: string;
  note: string;
  clientDisplayName?: string | null;
  clientIgUsername?: string | null;
}): Promise<void> {
  const note = params.note.trim();
  if (!note) return;

  const clientLabel = clientLabelFrom({
    displayName: params.clientDisplayName,
    igUsername: params.clientIgUsername,
  });
  const adminUrl = adminConversationUrl(params.conversationId);
  const text = truncateTelegramText(
    [
      escapeHtml(note),
      ``,
      `Клієнт: ${escapeHtml(clientLabel)}`,
      `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
    ].join('\n'),
  );

  await sendToManagerGroup(text, undefined, 'handoff', 'private');
}

/**
 * SLA reminder while the thread is already in handoff (not a second full
 * escalation card and not a live transcript of every client bubble).
 */
export async function notifyHandoffFollowUp(params: {
  conversationId: string;
  clientIgUserId: string;
  clientDisplayName?: string | null;
  clientIgUsername?: string | null;
  text: string;
  isVoice?: boolean;
  slaHours?: number;
}): Promise<void> {
  const body = unwrapCoalescePreamble(params.text).trim();
  if (!body) return;
  if (isHandoffServiceNote(body, 'client')) return;
  if (isSyntheticReactionText(body)) return;

  const adminUrl = adminConversationUrl(params.conversationId);
  const clientLabel = clientLabelFrom({
    displayName: params.clientDisplayName,
    igUsername: params.clientIgUsername,
    igUserId: params.clientIgUserId,
  });
  const icon = params.isVoice ? '👤🎤' : '👤';
  const slaLabel =
    typeof params.slaHours === 'number' && params.slaHours > 0
      ? ` (${params.slaHours} роб. год.)`
      : '';

  const text = [
    `⏱ <b>Клієнт чекає довше SLA${slaLabel}</b>`,
    ``,
    `Клієнт: ${escapeHtml(clientLabel)}`,
    ``,
    `${icon} ${escapeHtml(body)}`,
    ``,
    `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
  ].join('\n');

  await sendToManagerGroup(text, undefined, 'handoff');
}

/**
 * Sends an order card to the manager group when a new order is created.
 */
export async function notifyOrder(params: {
  orderId: string;
  conversationId: string;
  clientIgUserId: string;
  items: Array<{ name: string; variant?: string; price: number; qty: number }>;
  /** Final total quoted to the customer; falls back to catalog sum. */
  quotedTotal?: number | null;
  customerName: string;
  phone: string;
  city?: string | null;
  npBranch?: string | null;
  paymentMethod?: string | null;
  kind?: string | null;
  summary?: string | null;
}): Promise<void> {
  const {
    orderId,
    conversationId,
    clientIgUserId,
    items,
    quotedTotal: quotedArg,
    customerName,
    phone,
    city,
    npBranch,
    paymentMethod,
    kind,
    summary,
  } = params;
  const shortId = orderId.slice(0, 8);
  const adminUrl = adminConversationUrl(conversationId);

  const catalogTotal = items.reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1),
    0,
  );
  const quotedTotal =
    typeof quotedArg === 'number' && Number.isFinite(quotedArg) && quotedArg >= 0
      ? Math.round(quotedArg * 100) / 100
      : Math.round(catalogTotal * 100) / 100;
  const showCatalogDelta = Math.abs(quotedTotal - catalogTotal) >= 0.01;

  const itemsBlock = items
    .map((item) => {
      const name = item.name?.trim() || 'Товар';
      const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
      const price = Number(item.price) || 0;
      const variant = item.variant ? ` (${escapeHtml(item.variant)})` : '';
      return `• ${escapeHtml(name)}${variant} × ${qty} - ${price} ₴`;
    })
    .join('\n');

  const kindLabel =
    kind === 'service'
      ? 'послуга'
      : kind === 'callback'
        ? 'дзвінок'
        : kind === 'other'
          ? 'інше'
          : kind === 'booking'
            ? 'запис'
            : kind === 'product'
              ? 'товар'
              : null;

  const title =
    kind === 'booking'
      ? `Запис оформлено #${escapeHtml(shortId)}`
      : kind && kind !== 'product'
        ? `Нова заявка (${kindLabel}) #${escapeHtml(shortId)}`
        : `Нове замовлення #${escapeHtml(shortId)}`;

  const bookingDoneLine =
    kind === 'booking'
      ? `Агент оформив запис (локально + CRM). Клієнту вже надіслано підтвердження.`
      : null;

  const totalsBlock =
    quotedTotal > 0 || catalogTotal > 0
      ? [
          `<b>Разом (озвучено): ${quotedTotal} ₴</b>`,
          showCatalogDelta ? `каталог: ${catalogTotal} ₴` : null,
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  const text = [
    kind === 'booking' ? `✅ <b>${title}</b>` : `📦 <b>${title}</b>`,
    ``,
    bookingDoneLine,
    summary ? `Суть: ${escapeHtml(summary)}` : '',
    `Клієнт: ${escapeHtml(
      formatTelegramClientLabel({
        displayName: customerName,
        igUserId: clientIgUserId,
      }),
    )}`,
    `Ім'я: ${escapeHtml(customerName)}`,
    `Телефон: ${escapeHtml(phone)}`,
    kind === 'booking' ? null : `Місто: ${escapeHtml(city?.trim() || '—')}`,
    kind === 'booking'
      ? npBranch?.trim()
        ? `Дата/час: ${escapeHtml(npBranch.trim())}`
        : null
      : `НП: ${escapeHtml(npBranch?.trim() || '—')}`,
    kind === 'booking'
      ? null
      : `Оплата: ${escapeHtml(
          paymentMethod ? formatPaymentMethodLabel(paymentMethod) : '—',
        )}`,
    ``,
    `<b>Позиції:</b>`,
    itemsBlock || '<i>(немає позицій)</i>',
    totalsBlock,
    ``,
    `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
  ]
    .filter((line) => line !== '' && line != null)
    .join('\n');

  // Agent already confirmed to the client — notify only. Approve/decline would
  // re-message Instagram and duplicate a decision the agent already made.
  await sendToManagerGroup(text, undefined, 'order');
}

/**
 * Notify-only card when agent cancels / removes a service / reschedules a booking.
 */
/**
 * Client running late — short card for managers (not a handoff).
 */
export async function notifyClientRunningLate(params: {
  conversationId: string;
  clientIgUserId?: string | null;
  customerName: string;
  phone?: string | null;
  minutesLate?: number | null;
  masterName?: string | null;
  scheduledTime?: string | null;
  note?: string | null;
}): Promise<void> {
  const {
    conversationId,
    clientIgUserId,
    customerName,
    phone,
    minutesLate,
    masterName,
    scheduledTime,
    note,
  } = params;
  const adminUrl = adminConversationUrl(conversationId);
  const delay =
    typeof minutesLate === 'number' && Number.isFinite(minutesLate) && minutesLate > 0
      ? `~${Math.round(minutesLate)} хв`
      : 'час не уточнено';
  const text = [
    `⏱ <b>Клієнт запізнюється</b>`,
    ``,
    `Ім'я: ${escapeHtml(customerName || '—')}`,
    phone ? `Телефон: ${escapeHtml(phone)}` : null,
    clientIgUserId
      ? `Клієнт: ${escapeHtml(
          formatTelegramClientLabel({
            displayName: customerName,
            igUserId: clientIgUserId,
          }),
        )}`
      : null,
    masterName ? `Майстер: ${escapeHtml(masterName)}` : null,
    scheduledTime ? `Запис на: ${escapeHtml(scheduledTime)}` : null,
    `Запізнення: ${escapeHtml(delay)}`,
    note ? `Примітка: ${escapeHtml(note)}` : null,
    ``,
    `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
  ]
    .filter((line) => line !== '' && line != null)
    .join('\n');

  await sendToManagerGroup(text, undefined, 'order');
}

export async function notifyBookingLifecycle(params: {
  kind: 'cancelled' | 'service_removed' | 'rescheduled';
  appointmentId: string;
  conversationId: string;
  clientIgUserId?: string | null;
  summary: string;
  customerName: string;
  phone: string;
  reason?: string | null;
}): Promise<void> {
  const {
    kind,
    appointmentId,
    conversationId,
    clientIgUserId,
    summary,
    customerName,
    phone,
    reason,
  } = params;
  const shortId = appointmentId.slice(0, 8);
  const adminUrl = adminConversationUrl(conversationId);
  const title =
    kind === 'cancelled'
      ? `Запис скасовано #${escapeHtml(shortId)}`
      : kind === 'rescheduled'
        ? `Запис перенесено #${escapeHtml(shortId)}`
        : `Послугу прибрано з запису #${escapeHtml(shortId)}`;
  const lead =
    kind === 'cancelled'
      ? 'Агент скасував запис у CRM.'
      : kind === 'rescheduled'
        ? 'Агент переніс запис (старий скасовано, новий створено).'
        : 'Агент прибрав одну послугу з візиту.';

  const text = [
    `✅ <b>${title}</b>`,
    ``,
    lead,
    reason ? `Причина: ${escapeHtml(reason)}` : null,
    `Суть: ${escapeHtml(summary)}`,
    clientIgUserId
      ? `Клієнт: ${escapeHtml(
          formatTelegramClientLabel({
            displayName: customerName,
            igUserId: clientIgUserId,
          }),
        )}`
      : null,
    `Ім'я: ${escapeHtml(customerName)}`,
    `Телефон: ${escapeHtml(phone)}`,
    ``,
    `<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`,
  ]
    .filter((line) => line !== '' && line != null)
    .join('\n');

  await sendToManagerGroup(text, undefined, 'order');
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

  const lines: string[] = [];
  lines.push(`📋 <b>Новий пресейл-бриф #${escapeHtml(shortBrief)}</b>`);
  lines.push('');
  lines.push(`Клієнт: ${escapeHtml(formatTelegramClientLabel({ igUserId: clientIgUserId }))}`);
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

  await sendToManagerGroup(lines.join('\n'), keyboard, 'brief');
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
    lines.push(
      `Клієнт: ${escapeHtml(formatTelegramClientLabel({ igUserId: clientIgUserId }))}`,
    );
  }
  lines.push(`Причина: <code>${escapeHtml(reason)}</code>`);
  lines.push('');
  for (const { label, value } of snapshot) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}`);
  }

  await sendToManagerGroup(lines.join('\n'), undefined, 'crm_fallback');
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

  await sendToManagerGroup(text, undefined, 'agent_failure');
}

/** Soft debounce so retry worker + first fallback don't spam the group. */
const AGENT_FAILURE_NOTIFY_COOLDOWN_MS = 90_000;
const lastAgentFailureNotifyAt = new Map<string, number>();

/**
 * Alert when the sales agent could not produce a real reply (Claude busy /
 * timeout / CLI error / output validation). Skips silently if Telegram is
 * not configured. Debounced per conversation.
 */
export async function notifyAgentFailure(params: {
  conversationId: string;
  clientIgUserId?: string | null;
  clientDisplayName?: string | null;
  clientIgUsername?: string | null;
  failureCode: 'busy' | 'timeout' | 'output_validation';
  failureDetail: string;
  clientMessage?: string | null;
}): Promise<void> {
  const {
    conversationId,
    clientIgUserId,
    clientDisplayName,
    clientIgUsername,
    failureCode,
    failureDetail,
    clientMessage,
  } = params;

  const now = Date.now();
  const lastAt = lastAgentFailureNotifyAt.get(conversationId) ?? 0;
  if (now - lastAt < AGENT_FAILURE_NOTIFY_COOLDOWN_MS) {
    log.debug({ conversationId }, 'Skipping agent-failure Telegram notify (cooldown)');
    return;
  }
  lastAgentFailureNotifyAt.set(conversationId, now);

  const adminUrl = adminConversationUrl(conversationId);
  const codeLabel =
    failureCode === 'busy'
      ? 'черга / перевантаження'
      : failureCode === 'output_validation'
        ? 'валідація відповіді'
        : 'таймаут / помилка Claude';

  const detail =
    failureDetail.length > 1200 ? `${failureDetail.slice(0, 1200)}…` : failureDetail;
  const clientPreview = clientMessage?.trim()
    ? clientMessage.trim().slice(0, 200)
    : null;

  const lines = [
    `🚨 <b>Агент не відповів</b> [${escapeHtml(config.INSTANCE_ID)}]`,
    ``,
    `Код: <code>${escapeHtml(failureCode)}</code> (${escapeHtml(codeLabel)})`,
  ];
  const label = formatTelegramClientLabel({
    displayName: clientDisplayName,
    igUsername: clientIgUsername,
    igUserId: clientIgUserId,
  });
  if (clientDisplayName?.trim() || clientIgUsername?.trim() || clientIgUserId) {
    lines.push(`Клієнт: ${escapeHtml(label)}`);
  }
  if (clientPreview) {
    lines.push(`Запит: «${escapeHtml(clientPreview)}»`);
  }
  lines.push(``);
  lines.push(`<code>${escapeHtml(detail)}</code>`);
  lines.push(``);
  lines.push(`<a href="${escapeHtml(adminUrl)}">Відкрити діалог в адмінці</a>`);

  await sendToManagerGroup(lines.join('\n'), undefined, 'agent_failure');
}

/**
 * Sends a token expiry warning to the manager group.
 */
export async function notifyTokenExpiry(daysLeft: number): Promise<void> {
  const text = [
    `⏰ <b>IG Token Expiry Warning</b>`,
    ``,
    `Токен Instagram закінчується через <b>${daysLeft}</b> днів.`,
    `Перепідключіть Instagram у Налаштуваннях адмінки або оновіть токен і перезапустіть додатки.`,
  ].join('\n');

  await sendToManagerGroup(text, undefined, 'auth');
}
