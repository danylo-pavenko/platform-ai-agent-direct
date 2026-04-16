import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { askClaude } from './claude.js';
import { sendText } from './instagram.js';
import {
  buildRuntimePrompt,
  getActivePrompt,
  getWorkingHours,
  isWithinWorkingHours,
  loadCatalogSnippet,
} from './prompt-builder.js';
import { downloadAllMedia } from './media.js';
import { notifyHandoff } from './telegram-notify.js';

const log = pino({ name: 'conversation' });

/** Regex to detect leaked internal IDs / prices in bot output */
const LEAKED_INTERNALS_RE = /product_id|offer_id|purchased_price/i;

/** Default message when out-of-hours template is not configured */
const DEFAULT_OUT_OF_HOURS =
  'Дякуємо за повідомлення! Наразі ми не працюємо, але відповімо вам у робочий час.';

/** Duration in ms to consider a conversation "recently active" */
const RECENT_ACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

/** Max messages to include in Claude conversation history */
const MAX_HISTORY_MESSAGES = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOutOfHoursTemplate(): Promise<string> {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: 'out_of_hours_template' },
    });

    if (setting?.value && typeof setting.value === 'string') {
      return setting.value;
    }

    // The value might be stored as a JSON string
    if (setting?.value && typeof setting.value === 'object') {
      const val = (setting.value as Record<string, unknown>).text;
      if (typeof val === 'string') return val;
    }

    return DEFAULT_OUT_OF_HOURS;
  } catch (err) {
    log.error({ err }, 'Failed to fetch out_of_hours_template');
    return DEFAULT_OUT_OF_HOURS;
  }
}

async function hasRecentActivity(conversationId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - RECENT_ACTIVITY_MS);

  const recentMessage = await prisma.message.findFirst({
    where: {
      conversationId,
      createdAt: { gte: cutoff },
    },
    select: { id: true },
  });

  return recentMessage !== null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handles an incoming Instagram message for a conversation.
 *
 * Orchestrates the full flow: state check, working-hours gate,
 * prompt building, Claude invocation, tool-call handling, output
 * validation, and response delivery.
 */
export async function handleIncomingMessage(
  conversationId: string,
  messageText: string,
  mediaUrls?: string[],
): Promise<void> {
  // ── 1. Fetch conversation with client ─────────────────────────────
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { client: true },
  });

  if (!conversation) {
    log.error({ conversationId }, 'Conversation not found');
    return;
  }

  const { client } = conversation;

  if (!client.igUserId) {
    log.error({ conversationId, clientId: client.id }, 'Client has no igUserId');
    return;
  }

  // ── 2. Handoff state — skip bot response ──────────────────────────
  if (conversation.state === 'handoff') {
    log.info(
      { conversationId },
      'Message in handoff mode, skipping bot response',
    );
    // Forward message to Telegram manager group for handoff conversations
    notifyHandoff({
      conversationId,
      clientIgUserId: client.igUserId!,
      reason: conversation.handoffReason || 'Клієнт написав під час хендофу',
      lastMessages: [{ sender: 'client', text: messageText }],
    }).catch((err) => log.error({ err }, 'Failed to forward to Telegram'));
    return;
  }

  // ── 3. Closed / paused — ignore ──────────────────────────────────
  if (conversation.state === 'closed' || conversation.state === 'paused') {
    log.debug(
      { conversationId, state: conversation.state },
      'Conversation closed or paused, ignoring',
    );
    return;
  }

  // ── 4. Working hours check ────────────────────────────────────────
  const hours = await getWorkingHours();
  const now = new Date();

  if (!isWithinWorkingHours(now, hours)) {
    const recentlyActive = await hasRecentActivity(conversationId);

    if (!recentlyActive) {
      const template = await getOutOfHoursTemplate();

      try {
        await sendText(client.igUserId, template);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to send out-of-hours message');
        return;
      }

      // Persist the bot message
      await prisma.message.create({
        data: {
          conversationId,
          direction: 'out',
          sender: 'bot',
          text: template,
        },
      });

      log.info({ conversationId }, 'Sent out-of-hours template');
      return;
    }

    // Recently active — continue serving even outside hours
    log.debug(
      { conversationId },
      'Outside working hours but conversation recently active, continuing',
    );
  }

  // ── 5. Build prompt ───────────────────────────────────────────────
  const activePrompt = await getActivePrompt();
  const catalog = await loadCatalogSnippet();

  const prompt = buildRuntimePrompt({
    activePromptContent: activePrompt,
    catalogSnippet: catalog,
    currentTime: now,
    workingHours: hours,
    conversationState: conversation.state as 'bot' | 'handoff',
    clientIgUsername: client.igUserId,
    conversationIdShort: conversation.id.slice(0, 8),
  });

  // ── 6. Build conversation history (last 30 messages) ──────────────
  const rawMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_MESSAGES,
    select: { direction: true, text: true },
  });

  // Reverse to chronological order & filter out system / empty
  const history = rawMessages
    .reverse()
    .filter((m) => m.direction !== 'system' && m.text)
    .map((m) => ({
      role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text!,
    }));

  // ── 7. Download media if present ──────────────────────────────────
  const localPaths =
    mediaUrls && mediaUrls.length > 0
      ? await downloadAllMedia(mediaUrls)
      : [];

  // ── 8. Call Claude ────────────────────────────────────────────────
  const response = await askClaude({
    systemPrompt: prompt,
    conversationHistory: history,
    userMessage: messageText,
    images: localPaths.length > 0 ? localPaths : undefined,
  });

  // ── 9. Handle tool calls ──────────────────────────────────────────
  if (response.toolCalls && response.toolCalls.length > 0) {
    const handoff = response.toolCalls.find((tc) => tc.name === 'request_handoff');
    if (handoff) {
      const reason =
        typeof handoff.args.reason === 'string'
          ? handoff.args.reason
          : 'Клієнт потребує менеджера';

      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          state: 'handoff',
          handoffReason: reason,
        },
      });

      const handoffMessage = 'Зачекайте, будь ласка, зʼєдную вас з менеджером.';

      try {
        await sendText(client.igUserId, handoffMessage);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to send handoff message');
      }

      await prisma.message.create({
        data: {
          conversationId,
          direction: 'out',
          sender: 'bot',
          text: handoffMessage,
        },
      });

      log.info({ conversationId, reason }, 'Conversation handed off to manager');

      // Notify Telegram manager group about the handoff
      const recentMsgs = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { sender: true, text: true },
      });
      notifyHandoff({
        conversationId,
        clientIgUserId: client.igUserId!,
        reason,
        lastMessages: recentMsgs
          .reverse()
          .filter((m) => m.text)
          .map((m) => ({ sender: m.sender, text: m.text! })),
      }).catch((err) => log.error({ err }, 'Failed to send handoff notification'));
      return;
    }

    const collectOrder = response.toolCalls.find((tc) => tc.name === 'collect_order');
    if (collectOrder) {
      // TODO: handle order (H.2)
      log.info(
        { conversationId, args: collectOrder.args },
        'collect_order tool call received (not yet implemented)',
      );
    }
  }

  // ── 10. Validate output ───────────────────────────────────────────
  let responseText = response.text;

  if (LEAKED_INTERNALS_RE.test(responseText)) {
    log.warn(
      { conversationId, originalResponse: responseText },
      'Bot response contained internal IDs — replacing with safe fallback',
    );
    responseText = 'Дякую за запитання! Зверніться до менеджера для деталей.';
  }

  // ── 11. Send response ─────────────────────────────────────────────
  try {
    await sendText(client.igUserId, responseText);
  } catch (err) {
    log.error({ err, conversationId }, 'Failed to send bot response to Instagram');
    // Still persist the message even if delivery failed
  }

  // ── 12. Persist bot message ───────────────────────────────────────
  await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      sender: 'bot',
      text: responseText,
    },
  });

  log.info(
    { conversationId, responseLength: responseText.length },
    'Bot response sent and persisted',
  );
}
