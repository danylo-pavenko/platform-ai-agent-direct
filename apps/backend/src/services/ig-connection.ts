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
import { importIgConversationHistory, getPageIgUserId } from './ig-history.js';
import { fetchIgUserProfile } from './ig-profile.js';

const log = pino({ name: 'ig-connection' });

const IG_API_BASE = 'https://graph.facebook.com/v21.0';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IgConnectionStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
  igAccount?: {
    id: string;
    username?: string;
    name?: string;
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
 * Verifies the configured Meta Page Access Token is valid and returns
 * the linked Instagram Business account info.
 *
 * Calls: GET /me?fields=id,name,instagram_business_account{id,username,name}
 */
export async function checkIgConnectionStatus(): Promise<IgConnectionStatus> {
  const { meta } = await getIntegrationConfig();

  if (!meta.pageAccessToken) {
    return { connected: false, error: 'Page Access Token не налаштовано' };
  }

  try {
    const url = new URL(`${IG_API_BASE}/me`);
    url.searchParams.set(
      'fields',
      'id,name,instagram_business_account{id,username,name}',
    );
    url.searchParams.set('access_token', meta.pageAccessToken);

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
        error: `Meta API: ${res.status} — ${body.slice(0, 160) || 'помилка'}`,
      };
    }

    const data = (await res.json()) as {
      id?: string;
      name?: string;
      instagram_business_account?: {
        id?: string;
        username?: string;
        name?: string;
      };
    };

    const ig = data.instagram_business_account;

    return {
      connected: true,
      pageId: data.id,
      pageName: data.name,
      igAccount: ig?.id
        ? {
            id: ig.id,
            username: ig.username,
            name: ig.name,
          }
        : undefined,
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
  const pageToken = meta.pageAccessToken;

  if (!pageToken) {
    throw new Error('Page Access Token не налаштовано');
  }

  const pageIgUserId = await getPageIgUserId(pageToken);

  // Meta Graph caps a single page at 50, but the caller may ask for more
  // (e.g. the 200-conversation Public-mode backfill). Paginate via `next`
  // cursor until we have enough threads or run out of history.
  const target = Math.max(1, Math.min(500, limit));
  const pageSize = Math.min(50, target);

  const threads: IgConversationListItem[] = [];

  const firstUrl = new URL(`${IG_API_BASE}/me/conversations`);
  firstUrl.searchParams.set('platform', 'instagram');
  firstUrl.searchParams.set('fields', 'id,updated_time,participants');
  firstUrl.searchParams.set('limit', String(pageSize));
  firstUrl.searchParams.set('access_token', pageToken);

  let nextUrl: string | null = firstUrl.toString();

  while (nextUrl && threads.length < target) {
    const pageRes: Response = await fetch(nextUrl, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!pageRes.ok) {
      const body = await pageRes.text().catch(() => '');
      throw new Error(
        `Meta API conversations list failed: ${pageRes.status} ${body.slice(0, 200)}`,
      );
    }

    const pageData = (await pageRes.json()) as IgConversationListResponse;
    threads.push(...(pageData.data ?? []));
    nextUrl = pageData.paging?.next ?? null;
  }

  if (threads.length > target) threads.length = target;

  log.info({ count: threads.length, target }, 'Fetched recent IG conversations');

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

    // Counterparty = first participant whose id != our page IG id
    const counterparty = participants.find((p) => p.id !== pageIgUserId);
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
        { pageIgUserId },
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
