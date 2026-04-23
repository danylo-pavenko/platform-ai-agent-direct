/**
 * ig-history.ts
 *
 * Imports historical Instagram conversation messages into our database
 * via the Facebook Graph API Conversations endpoint.
 *
 * API flow:
 *   1. GET /{PAGE_ID}/conversations?platform=instagram&user_id={igsid}
 *      → returns conversation IDs for this user
 *   2. GET /{conversation-id}/messages?fields=id,message,from,to,created_time
 *      → returns paginated messages
 *
 * All imported messages are stored with `igMessageId` set so re-importing
 * is idempotent (duplicates are skipped via upsert).
 *
 * Requires: instagram_manage_messages scope on the Page Access Token.
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from '../lib/integration-config.js';

const log = pino({ name: 'ig-history' });

const FB_GRAPH_BASE = 'https://graph.facebook.com/v22.0';
const MAX_IMPORT_MESSAGES = 200;

interface IgApiMessage {
  id: string;
  message?: string;
  from?: { id: string; name?: string };
  to?: { data: Array<{ id: string; name?: string }> };
  created_time: string;
}

interface IgApiMessagesResponse {
  data: IgApiMessage[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
}

interface IgApiConversation {
  id: string;
}

interface IgApiConversationsResponse {
  data: IgApiConversation[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
  managerReplies: number;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetches IG conversation history for a client and imports into our DB.
 * Returns counts of imported / skipped messages.
 *
 * Outgoing messages ('out') are classified as:
 *   - 'bot'     if this conversation already has bot-authored messages in DB
 *   - 'manager' otherwise (replies sent manually from IG app before bot was active)
 */
export async function importIgConversationHistory(
  conversationId: string,
  igScopedUserId: string,
  opts: { ownIgUserId?: string } = {},
): Promise<ImportResult> {
  const { meta } = await getIntegrationConfig();
  const accessToken = meta.pageAccessToken;
  const pageId = meta.pageId;

  if (!accessToken || !pageId) {
    log.warn({ conversationId }, 'pageAccessToken or pageId not configured, skipping import');
    return { imported: 0, skipped: 0, total: 0, managerReplies: 0 };
  }

  // 1. Find the conversation thread between our Page/IG account and this user
  const igConversationId = await findIgConversationId(igScopedUserId, pageId, accessToken);

  if (!igConversationId) {
    log.info({ igScopedUserId }, 'No IG conversation found for this user');
    return { imported: 0, skipped: 0, total: 0, managerReplies: 0 };
  }

  // 2. Fetch messages from the thread
  const igMessages = await fetchIgMessages(igConversationId, accessToken);

  log.info(
    { conversationId, igConversationId, count: igMessages.length },
    'Fetched IG messages for import',
  );

  // 3. Our own IG user id (to distinguish sent vs received)
  const ownIgUserId = opts.ownIgUserId || meta.igUserId;

  // 3b. Does this conversation already have bot-authored messages?
  const botMessageCount = await prisma.message.count({
    where: { conversationId, sender: 'bot' },
  });
  const hasBotHistory = botMessageCount > 0;

  // 4. Import into DB (idempotent via igMessageId)
  let imported = 0;
  let skipped = 0;
  let managerReplies = 0;

  const sorted = [...igMessages].sort(
    (a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
  );

  for (const msg of sorted) {
    if (!msg.message?.trim()) {
      skipped++;
      continue;
    }

    const existing = await prisma.message.findUnique({
      where: { igMessageId: msg.id },
      select: { id: true },
    });

    if (existing) {
      skipped++;
      continue;
    }

    const senderId = msg.from?.id ?? '';
    const direction: 'in' | 'out' = senderId === ownIgUserId ? 'out' : 'in';
    const sender =
      direction === 'out' ? (hasBotHistory ? 'bot' : 'manager') : 'client';

    if (sender === 'manager') managerReplies++;

    await prisma.message.create({
      data: {
        conversationId,
        direction,
        sender,
        text: msg.message.trim(),
        igMessageId: msg.id,
        createdAt: new Date(msg.created_time),
      },
    });

    imported++;
  }

  if (imported > 0 && sorted.length > 0) {
    const newestTs = new Date(sorted[sorted.length - 1].created_time);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: newestTs },
    });
    log.info(
      { conversationId, imported, skipped },
      'IG history import complete',
    );
  }

  return { imported, skipped, total: igMessages.length, managerReplies };
}

// ── Private helpers ──────────────────────────────────────────────────────────

async function findIgConversationId(
  igScopedUserId: string,
  pageId: string,
  accessToken: string,
): Promise<string | null> {
  const url = new URL(`${FB_GRAPH_BASE}/${pageId}/conversations`);
  url.searchParams.set('platform', 'instagram');
  url.searchParams.set('user_id', igScopedUserId);
  url.searchParams.set('fields', 'id');

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn({ status: res.status, body: body.slice(0, 300) }, 'IG conversations API error');
      return null;
    }

    const data = (await res.json()) as IgApiConversationsResponse;
    return data.data?.[0]?.id ?? null;
  } catch (err) {
    log.error({ err, igScopedUserId }, 'Failed to fetch IG conversation ID');
    return null;
  }
}

async function fetchIgMessages(
  igConversationId: string,
  accessToken: string,
): Promise<IgApiMessage[]> {
  const messages: IgApiMessage[] = [];
  let nextUrl: string | null = buildMessagesUrl(igConversationId);

  while (nextUrl && messages.length < MAX_IMPORT_MESSAGES) {
    const stripped = new URL(nextUrl);
    stripped.searchParams.delete('access_token');
    const res = await fetch(stripped.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn({ status: res.status, body: body.slice(0, 300) }, 'IG messages API error');
      break;
    }

    const page = (await res.json()) as IgApiMessagesResponse;
    messages.push(...(page.data ?? []));

    nextUrl = page.paging?.next ?? null;
  }

  return messages.slice(0, MAX_IMPORT_MESSAGES);
}

function buildMessagesUrl(igConversationId: string): string {
  const url = new URL(`${FB_GRAPH_BASE}/${igConversationId}/messages`);
  url.searchParams.set('fields', 'id,message,from,to,created_time');
  url.searchParams.set('limit', '50');
  return url.toString();
}
