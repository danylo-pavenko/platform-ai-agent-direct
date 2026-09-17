import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { getAgentConfig } from '../lib/agent-config.js';
import { joinInboundBatch, type PendingInboundMessage } from '../lib/inbound-coalesce.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import { sendText } from './instagram.js';
import { runForcedManagerBotTurn, type BotTurnOutcome } from './conversation.js';
import {
  buildManagerForcedTurnUserMessage,
  formatPaymentRequisitesMessage,
  isManagerChatAction,
  type ManagerChatAction,
  type ManagerForcedClaudeAction,
} from '../lib/manager-chat-actions.js';

const log = pino({ name: 'manager-chat-actions' });

export class ManagerChatActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ManagerChatActionError';
  }
}

export type ManagerChatActionOk =
  | {
      ok: true;
      action: 'send_payment_details';
      message: { id: string; text: string | null; createdAt: Date; sender: string };
    }
  | {
      ok: true;
      action: ManagerForcedClaudeAction;
      outcome: BotTurnOutcome;
    };

export async function runManagerChatAction(
  conversationId: string,
  actionRaw: unknown,
): Promise<ManagerChatActionOk> {
  if (!isManagerChatAction(actionRaw)) {
    throw new ManagerChatActionError('invalid_action', 'Невідома дія', 400);
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      client: {
        select: { igUserId: true },
      },
    },
  });
  if (!conversation) {
    throw new ManagerChatActionError('not_found', 'Розмову не знайдено', 404);
  }
  if (conversation.state === 'closed') {
    throw new ManagerChatActionError('conversation_closed', 'Розмова закрита', 409);
  }
  if (!conversation.client.igUserId) {
    throw new ManagerChatActionError(
      'client_has_no_ig',
      'У клієнта немає Instagram ID',
      400,
    );
  }

  if (actionRaw === 'send_payment_details') {
    return sendPaymentDetails(conversationId, conversation.client.igUserId);
  }

  return runForcedClaudeAction(conversationId, actionRaw);
}

async function sendPaymentDetails(
  conversationId: string,
  igUserId: string,
): Promise<ManagerChatActionOk> {
  const cfg = await getAgentConfig();
  const text = formatPaymentRequisitesMessage(cfg.paymentRequisites);
  if (!text) {
    throw new ManagerChatActionError(
      'payment_requisites_not_configured',
      'Спочатку заповніть реквізити в Налаштуваннях → Тип агента та SLA',
      400,
    );
  }

  try {
    await sendText(igUserId, text);
  } catch (err) {
    log.error({ err, conversationId }, 'Failed to send payment requisites to Instagram');
    throw new ManagerChatActionError(
      'ig_send_failed',
      'Не вдалося надіслати повідомлення в Instagram',
      502,
    );
  }

  const now = new Date();
  const message = await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      sender: 'bot',
      text,
      createdAt: now,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now },
  });
  markFirstOutboundAt(conversationId).catch((err) =>
    log.warn({ err, conversationId }, 'markFirstOutboundAt failed (non-fatal)'),
  );

  log.info({ conversationId, chars: text.length }, 'Manager sent payment requisites');
  return { ok: true, action: 'send_payment_details', message };
}

async function runForcedClaudeAction(
  conversationId: string,
  action: ManagerForcedClaudeAction,
): Promise<ManagerChatActionOk> {
  const cfg = await getAgentConfig();
  const batch = await loadUnansweredClientBatch(conversationId);
  const userMessage = buildManagerForcedTurnUserMessage({
    action,
    unansweredClientText: batch.text,
    paymentRequisites: cfg.paymentRequisites,
  });

  log.info(
    {
      conversationId,
      action,
      unansweredChars: batch.text.length,
      hasMedia: (batch.mediaAttachments?.length ?? 0) > 0 || (batch.mediaUrls?.length ?? 0) > 0,
    },
    'Starting manager forced Claude turn',
  );

  const outcome = await runForcedManagerBotTurn(conversationId, action, {
    text: userMessage,
    mediaUrls: batch.mediaUrls,
    mediaAttachments: batch.mediaAttachments,
    sharedPost: batch.sharedPost,
    igContext: batch.igContext,
    igMessageIds: batch.igMessageIds,
  });

  if (outcome === 'failed' || outcome === 'skipped' || outcome === 'released') {
    throw new ManagerChatActionError(
      'agent_failed',
      outcome === 'failed'
        ? 'Агент не встиг відповісти. Клієнту fallback не надсилали — спробуйте ще раз.'
        : 'Агент не відповів (розмову пропущено). Перевірте стан діалогу.',
      outcome === 'failed' ? 504 : 409,
    );
  }

  return { ok: true, action, outcome };
}

/** Client bubbles after the last real (non-fallback) bot/manager outbound. */
async function loadUnansweredClientBatch(
  conversationId: string,
): Promise<ReturnType<typeof joinInboundBatch>> {
  const lastOkOut = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: 'out',
      OR: [{ sender: 'manager' }, { sender: 'bot', botFailureCode: null }],
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const recent = await prisma.message.findMany({
    where: { conversationId, direction: 'in', sender: 'client' },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: {
      id: true,
      text: true,
      mediaUrls: true,
      mediaAttachments: true,
      sharedPost: true,
      igContext: true,
      igMessageId: true,
      createdAt: true,
    },
  });

  const chronological = [...recent].reverse();
  let unanswered = lastOkOut
    ? chronological.filter((m) => m.createdAt > lastOkOut.createdAt)
    : chronological;

  if (unanswered.length === 0) {
    unanswered = chronological.slice(-4);
  }

  const pending: PendingInboundMessage[] = unanswered.map((m) => ({
    id: m.id,
    text: m.text,
    mediaUrls: m.mediaUrls,
    mediaAttachments: m.mediaAttachments,
    sharedPost: m.sharedPost,
    igContext: m.igContext,
    igMessageId: m.igMessageId,
    createdAt: m.createdAt,
  }));

  if (pending.length === 0) {
    return {
      text: '',
      igMessageIds: [],
      messageIds: [],
    };
  }

  return joinInboundBatch(pending);
}
