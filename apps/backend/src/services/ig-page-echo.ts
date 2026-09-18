import pino from 'pino';
import { prisma, toInputJsonValue } from '../lib/prisma.js';
import { sanitizeMessage, redactSensitive } from '../lib/sanitize.js';
import { cancelPendingFollowUpsSafe } from '../lib/follow-up-schedule.js';
import { markFirstOutboundAt } from '../lib/conversation-metrics.js';
import {
  buildIgNativeEchoContext,
  echoConversationEffect,
  echoDisplayText,
  extractEchoEventsFromWebhookBody,
  HANDOFF_REASON_IG_NATIVE,
  matchOwnPlatformSend,
  type EchoWebhookEvent,
} from '../lib/ig-native-echo.js';

const log = pino({ name: 'ig-page-echo' });

function echoCreatedAt(event: EchoWebhookEvent): Date {
  const ts = event.timestamp;
  if (ts > 1_000_000_000_000) return new Date(ts);
  if (ts > 1_000_000_000) return new Date(ts * 1000);
  return new Date();
}

async function persistNativeIgEcho(event: EchoWebhookEvent): Promise<void> {
  const existing = await prisma.message.findUnique({
    where: { igMessageId: event.mid },
    select: { id: true },
  });
  if (existing) {
    log.debug({ mid: event.mid }, 'IG echo already stored — skip');
    return;
  }

  const client = await prisma.client.findUnique({
    where: { igUserId: event.recipientId },
    select: { id: true },
  });
  if (!client) {
    log.info(
      { recipientId: event.recipientId, mid: event.mid },
      'IG echo: no local client for recipient — not creating a conversation',
    );
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      clientId: client.id,
      channel: 'ig',
      state: { in: ['bot', 'handoff', 'paused'] },
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, state: true },
  });
  if (!conversation) {
    log.info(
      { clientId: client.id, mid: event.mid },
      'IG echo: no open conversation — not opening a new thread',
    );
    return;
  }

  const effect = echoConversationEffect(conversation.state);
  if (effect === 'skip') return;

  const recent = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      direction: 'out',
      sender: { in: ['bot', 'manager'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      text: true,
      sender: true,
      createdAt: true,
      igMessageId: true,
      igContext: true,
    },
  });

  const displayText = echoDisplayText(event);
  const own = matchOwnPlatformSend(
    { mid: event.mid, text: displayText || event.text },
    recent,
  );
  if (own) {
    if (own.kind === 'heuristic' && own.messageId) {
      const row = recent.find((r) => r.id === own.messageId);
      if (row && !row.igMessageId) {
        try {
          await prisma.message.update({
            where: { id: own.messageId },
            data: { igMessageId: event.mid },
          });
        } catch (err) {
          log.debug({ err, mid: event.mid }, 'IG echo: could not stamp mid on own send');
        }
      }
    }
    log.debug(
      { mid: event.mid, match: own.kind },
      'IG echo of our own Graph send — skip native bubble',
    );
    return;
  }

  const sanitized = redactSensitive(sanitizeMessage(displayText));
  const text = sanitized || displayText || '[повідомлення Instagram]';
  const createdAt = echoCreatedAt(event);

  try {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'out',
        sender: 'manager',
        text,
        igMessageId: event.mid,
        igContext: toInputJsonValue(buildIgNativeEchoContext('webhook_echo')),
        mediaUrls: event.mediaUrls.length > 0 ? toInputJsonValue(event.mediaUrls) : undefined,
        createdAt,
      },
    });
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      log.debug({ mid: event.mid }, 'IG echo duplicate mid (race) — skip');
      return;
    }
    throw err;
  }

  const now = new Date();
  const handoff = effect === 'handoff';
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: now,
      ...(handoff
        ? {
            state: 'handoff' as const,
            handoffReason: HANDOFF_REASON_IG_NATIVE,
            handedOffAt: now,
          }
        : {}),
    },
  });

  await prisma.client.update({
    where: { id: client.id },
    data: { lastActivityAt: now },
  });

  markFirstOutboundAt(conversation.id).catch((err) =>
    log.warn({ err, conversationId: conversation.id }, 'markFirstOutboundAt failed (non-fatal)'),
  );

  if (handoff) {
    cancelPendingFollowUpsSafe(conversation.id, 'ig_native_echo');
    log.info(
      { conversationId: conversation.id, mid: event.mid },
      'Native Instagram manager reply — handed off (no Telegram card)',
    );
  } else {
    log.info(
      { conversationId: conversation.id, mid: event.mid, state: conversation.state },
      'Native Instagram manager reply persisted',
    );
  }
}

/** Isolated from inbound: no Claude, no coalesce, no new conversation. */
export async function processIgPageEchoWebhook(body: unknown): Promise<void> {
  const events = extractEchoEventsFromWebhookBody(body);
  for (const event of events) {
    try {
      await persistNativeIgEcho(event);
    } catch (err) {
      log.error(
        { err, mid: event.mid, recipientId: event.recipientId },
        'Failed to persist Instagram page echo',
      );
    }
  }
}
