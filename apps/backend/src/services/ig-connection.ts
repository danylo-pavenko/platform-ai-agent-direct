/**
 * ig-connection.ts
 *
 * Endpoints that operate on the Instagram integration as a whole:
 *   - connection status (is the Page token / IG account working?)
 *   - bulk import of recent IG conversations (for onboarding a new client)
 *
 * Uses Facebook Graph API with Page Access Token (Facebook Login for Business).
 */

import pino from 'pino';
import { prisma } from '../lib/prisma.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { importIgConversationHistory } from './ig-history.js';
import { fetchIgUserProfile } from './ig-profile.js';

const log = pino({ name: 'ig-connection' });

const FB_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

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
 * Verifies the configured Page Access Token is still valid and returns
 * the connected Instagram Business account info.
 *
 * Calls: GET /me?fields=id,name,instagram_business_account{id,username,name}
 */
export async function checkIgConnectionStatus(): Promise<IgConnectionStatus> {
  const { meta } = await getIntegrationConfig();

  if (!meta.pageAccessToken) {
    return { connected: false, error: 'Facebook авторизацію не виконано — натисніть «Авторизуватись через Facebook»' };
  }

  try {
    const url = new URL(`${FB_GRAPH_BASE}/me`);
    url.searchParams.set('fields', 'id,name,instagram_business_account{id,username,name}');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${meta.pageAccessToken}` },
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
        error: `Facebook API: ${res.status} — ${body.slice(0, 160) || 'помилка'}`,
      };
    }

    const data = (await res.json()) as {
      id?: string;
      name?: string;
      instagram_business_account?: { id?: string; username?: string; name?: string };
      error?: { message?: string };
    };

    const igAccount = data.instagram_business_account;
    if (!igAccount?.id) {
      return {
        connected: false,
        error: 'Facebook Сторінку не підключено до Instagram Business акаунту',
      };
    }

    return {
      connected: true,
      igAccount: {
        id: igAccount.id,
        username: igAccount.username,
        name: igAccount.name,
        accountType: 'BUSINESS',
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
 */
export async function importRecentIgConversations(
  limit: number = 20,
): Promise<ImportRecentResult> {
  const { meta } = await getIntegrationConfig();
  const accessToken = meta.pageAccessToken;
  const pageId = meta.pageId;
  const ownIgUserId = meta.igUserId;

  if (!accessToken) {
    throw new Error('Facebook авторизацію не виконано');
  }

  if (!pageId) {
    throw new Error('Page ID не відомий — повторіть «Авторизуватись через Facebook»');
  }

  if (!ownIgUserId) {
    throw new Error('Instagram User ID не відомий — повторіть «Авторизуватись через Facebook»');
  }

  const target = Math.max(1, Math.min(500, limit));
  const pageSize = Math.min(50, target);

  const threads: IgConversationListItem[] = [];

  const firstUrl = new URL(`${FB_GRAPH_BASE}/${pageId}/conversations`);
  firstUrl.searchParams.set('platform', 'instagram');
  firstUrl.searchParams.set('fields', 'id,updated_time,participants');
  firstUrl.searchParams.set('limit', String(pageSize));

  log.info(
    { pageId, ownIgUserId, target, pageSize },
    'Starting IG conversations fetch via Facebook Graph API',
  );

  let nextUrl: string | null = firstUrl.toString();
  let pageCount = 0;
  const MAX_PAGES = 20;
  let emptyStreakDetected = false;

  while (nextUrl && threads.length < target && pageCount < MAX_PAGES) {
    const stripped = new URL(nextUrl);
    stripped.searchParams.delete('access_token');
    const pageRes: Response = await fetch(stripped.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!pageRes.ok) {
      const body = await pageRes.text().catch(() => '');
      log.error(
        { status: pageRes.status, body: body.slice(0, 500) },
        'IG conversations list returned non-OK',
      );
      throw new Error(
        `Facebook API conversations list failed: ${pageRes.status} ${body.slice(0, 200)}`,
      );
    }

    const pageData = (await pageRes.json()) as IgConversationListResponse;
    pageCount++;
    const pageItems = pageData.data ?? [];
    threads.push(...pageItems);

    if (pageCount === 1) {
      log.info(
        {
          returned: pageItems.length,
          hasNext: !!pageData.paging?.next,
          sample: pageItems.slice(0, 2),
        },
        'IG conversations first page',
      );
    }

    if (pageItems.length === 0) {
      emptyStreakDetected = true;
      log.info(
        { pageCount, hasNext: !!pageData.paging?.next },
        'IG conversations page returned empty — stopping pagination',
      );
      break;
    }

    nextUrl = pageData.paging?.next ?? null;
  }

  if (threads.length > target) threads.length = target;

  log.info(
    { count: threads.length, target, pageCount, emptyStreakDetected },
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

    const counterparty = participants.find((p) => p.id !== ownIgUserId);
    if (!counterparty?.id) {
      log.warn({ threadId: thread.id }, 'No counterparty found, skipping');
      result.conversationsSkipped++;
      continue;
    }

    const igUserId = counterparty.id;

    try {
      const existingClient = await prisma.client.findUnique({ where: { igUserId } });

      const profile =
        counterparty.username || counterparty.name
          ? { username: counterparty.username, name: counterparty.name }
          : await fetchIgUserProfile(igUserId).catch(() => null);

      const client = await prisma.client.upsert({
        where: { igUserId },
        update: {
          igUsername:  existingClient?.igUsername  || profile?.username || undefined,
          igFullName:  existingClient?.igFullName  || profile?.name     || undefined,
          displayName: existingClient?.displayName || profile?.name     || profile?.username || undefined,
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
          data: { clientId: client.id, channel: 'ig', state: 'bot' },
        });
      }

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
      log.error({ err, threadId: thread.id, igUserId }, 'Failed to import IG thread');
      result.conversationsSkipped++;
    }
  }

  log.info(result, 'Recent IG conversations import complete');
  return result;
}
