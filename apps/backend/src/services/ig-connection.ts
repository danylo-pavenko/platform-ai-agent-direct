/**
 * ig-connection.ts
 *
 * Endpoints that operate on the Instagram integration as a whole:
 *   - connection status (is the page / token working?)
 *   - bulk import of recent IG conversations (for onboarding a new client)
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { importIgConversationHistory, getOwnIgUserId } from './ig-history.js';
import { fetchIgUserProfile } from './ig-profile.js';

const log = pino({ name: 'ig-connection' });

const IG_API_BASE = 'https://graph.instagram.com/v21.0';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IgConnectionStatus {
  connected: boolean;
  igAccount?: {
    id: string;
    username?: string;
    name?: string;
    accountType?: string;
  };
  error?: string;
}

export interface ImportRecentResult {
  conversationsImported: number;
  conversationsSkipped: number;
  messagesImported: number;
  messagesSkipped: number;
  managerReplies: number;
  conversations: Array<{
    conversationId: string;
    clientDisplayName: string | null;
    igUserId: string;
    imported: number;
    skipped: number;
    managerReplies: number;
  }>;
}

// ── Connection status ────────────────────────────────────────────────────────

/**
 * Verifies the configured IG access token is still valid and returns
 * the Instagram Business/Creator account info.
 *
 * Calls: GET /me?fields=id,username,name,account_type
 */
export async function checkIgConnectionStatus(): Promise<IgConnectionStatus> {
  const { meta } = await getIntegrationConfig();

  if (!meta.igAccessToken) {
    return { connected: false, error: 'Instagram access token не налаштовано' };
  }

  try {
    const url = new URL(`${IG_API_BASE}/me`);
    url.searchParams.set('fields', 'id,username,name,account_type');
    url.searchParams.set('access_token', meta.igAccessToken);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(
        { status: res.status, body: body.slice(0, 300) },
        'IG status check failed',
      );
      return {
        connected: false,
        error: `Instagram API: ${res.status} — ${body.slice(0, 160) || 'помилка'}`,
      };
    }

    const data = (await res.json()) as {
      id?: string;
      username?: string;
      name?: string;
      account_type?: string;
    };

    if (!data.id) {
      return { connected: false, error: 'Не вдалося отримати IG user id' };
    }

    return {
      connected: true,
      igAccount: {
        id: data.id,
        username: data.username,
        name: data.name,
        accountType: data.account_type,
      },
    };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'Час очікування вичерпано'
          : err.message
        : String(err);
    log.error({ err }, 'IG status check error');
    return { connected: false, error: msg };
  }
}

// ── Bulk import of recent IG conversations ───────────────────────────────────

interface IgConversationListItem {
  id: string;
  updated_time?: string;
  participants?: {
    data: Array<{ id: string; username?: string; name?: string }>;
  };
}

interface IgConversationListResponse {
  data: IgConversationListItem[];
  paging?: { next?: string };
}

/**
 * Fetches the last `limit` IG conversations for the connected page and
 * imports their messages into our DB.
 *
 * For each thread:
 *   - finds the counterparty participant (not our page IG user)
 *   - upserts a Client (by igUserId) and Conversation
 *   - runs importIgConversationHistory to bring in the messages
 *   - 'out' messages are classified as 'manager' for conversations with no
 *      bot history (see ig-history.ts)
 */
export async function importRecentIgConversations(
  limit: number = 20,
): Promise<ImportRecentResult> {
  const { meta } = await getIntegrationConfig();
  const accessToken = meta.igAccessToken;

  if (!accessToken) {
    throw new Error('Instagram access token не налаштовано');
  }

  const ownIgUserId = await getOwnIgUserId(accessToken);

  // IG Graph caps a single page at 50, but the caller may ask for more
  // (e.g. the 200-conversation Public-mode backfill). Paginate via `next`
  // cursor until we have enough threads or run out of history.
  const target = Math.max(1, Math.min(500, limit));
  const pageSize = Math.min(50, target);

  const threads: IgConversationListItem[] = [];

  const firstUrl = new URL(`${IG_API_BASE}/me/conversations`);
  firstUrl.searchParams.set('platform', 'instagram');
  firstUrl.searchParams.set('fields', 'id,updated_time,participants');
  firstUrl.searchParams.set('limit', String(pageSize));
  firstUrl.searchParams.set('access_token', accessToken);

  log.info(
    { ownIgUserId, target, pageSize },
    'Starting IG conversations fetch',
  );

  let nextUrl: string | null = firstUrl.toString();
  let pageCount = 0;

  while (nextUrl && threads.length < target) {
    const pageRes: Response = await fetch(nextUrl, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!pageRes.ok) {
      const body = await pageRes.text().catch(() => '');
      log.error(
        { status: pageRes.status, body: body.slice(0, 500) },
        'IG conversations list returned non-OK',
      );
      throw new Error(
        `Instagram API conversations list failed: ${pageRes.status} ${body.slice(0, 200)}`,
      );
    }

    const pageData = (await pageRes.json()) as IgConversationListResponse;
    pageCount++;
    threads.push(...(pageData.data ?? []));
    // Log the first page in detail so we can diagnose "0 conversations"
    // (empty mailbox vs participants shape mismatch vs pending requests).
    if (pageCount === 1) {
      log.info(
        {
          returned: pageData.data?.length ?? 0,
          hasNext: !!pageData.paging?.next,
          sample: pageData.data?.slice(0, 2),
        },
        'IG conversations first page',
      );
    }
    nextUrl = pageData.paging?.next ?? null;
  }

  if (threads.length > target) threads.length = target;

  log.info(
    { count: threads.length, target, pageCount },
    'Fetched recent IG conversations',
  );

  const result: ImportRecentResult = {
    conversationsImported: 0,
    conversationsSkipped: 0,
    messagesImported: 0,
    messagesSkipped: 0,
    managerReplies: 0,
    conversations: [],
  };

  for (const thread of threads) {
    const participants = thread.participants?.data ?? [];

    // Counterparty = first participant whose id != our own IG id
    const counterparty = participants.find((p) => p.id !== ownIgUserId);
    if (!counterparty?.id) {
      log.warn({ threadId: thread.id }, 'No counterparty found, skipping');
      result.conversationsSkipped++;
      continue;
    }

    const igUserId = counterparty.id;

    try {
      // Upsert client (prefer IG profile data if Graph API returned it)
      const existingClient = await prisma.client.findUnique({
        where: { igUserId },
      });

      const profile =
        counterparty.username || counterparty.name
          ? {
              username: counterparty.username,
              name: counterparty.name,
            }
          : await fetchIgUserProfile(igUserId).catch(() => null);

      const client = await prisma.client.upsert({
        where: { igUserId },
        update: {
          // Fill in missing profile fields only
          igUsername:
            existingClient?.igUsername || profile?.username || undefined,
          igFullName: existingClient?.igFullName || profile?.name || undefined,
          displayName:
            existingClient?.displayName ||
            profile?.name ||
            profile?.username ||
            undefined,
          lastActivityAt: new Date(),
        },
        create: {
          igUserId,
          igUsername: profile?.username,
          igFullName: profile?.name,
          displayName: profile?.name ?? profile?.username,
          lastActivityAt: new Date(),
        },
      });

      // Find or create an IG conversation row
      let conversation = await prisma.conversation.findFirst({
        where: {
          clientId: client.id,
          channel: 'ig',
          state: { in: ['bot', 'handoff', 'paused'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      const isNewConversation = !conversation;

      if (!conversation) {
        conversation = await prisma.conversation.create({
          data: {
            clientId: client.id,
            channel: 'ig',
            state: 'bot',
          },
        });
      }

      // Import messages
      const imp = await importIgConversationHistory(
        conversation.id,
        igUserId,
        { ownIgUserId },
      );

      result.messagesImported += imp.imported;
      result.messagesSkipped += imp.skipped;
      result.managerReplies += imp.managerReplies;

      if (isNewConversation) {
        result.conversationsImported++;
      } else {
        result.conversationsSkipped++;
      }

      result.conversations.push({
        conversationId: conversation.id,
        clientDisplayName: client.displayName,
        igUserId,
        imported: imp.imported,
        skipped: imp.skipped,
        managerReplies: imp.managerReplies,
      });
    } catch (err) {
      log.error(
        { err, threadId: thread.id, igUserId },
        'Failed to import IG thread',
      );
      result.conversationsSkipped++;
    }
  }

  log.info(result, 'Recent IG conversations import complete');

  return result;
}
