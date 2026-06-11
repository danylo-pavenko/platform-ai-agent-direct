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
import { getIntegrationConfig, type IntegrationMeta } from '../lib/integration-config.js';
import {
  getPageWebhookSubscription,
  subscribePageToMetaWebhooks,
} from '../lib/meta-page-subscribe.js';
import { syncWebhookRoutingToHub } from '../lib/webhook-hub-sync.js';
import { importIgConversationHistory } from './ig-history.js';
import { fetchIgUserProfile } from './ig-profile.js';

const log = pino({ name: 'ig-connection' });

const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IgConnectionStatus {
  connected: boolean;
  page?: {
    id: string;
    name?: string;
  };
  igAccount?: {
    id: string;
    username?: string;
    name?: string;
    accountType?: string;
    source?: 'graph_page' | 'graph_ig_node' | 'configured';
  };
  webhook?: {
    subscribed: boolean;
    fields: string[];
    autoSubscribed?: boolean;
    error?: string;
  };
  business?: {
    id: string;
    name: string;
  };
  conversationsCount?: number;
  warnings?: string[];
  error?: string;
}

interface ResolvedIgAccount {
  id: string;
  username?: string;
  name?: string;
  source: NonNullable<IgConnectionStatus['igAccount']>['source'];
}

async function graphGet<T>(
  path: string,
  pageAccessToken: string,
  fields?: string,
): Promise<{ ok: boolean; status: number; data?: T; body?: string }> {
  const url = new URL(`${FB_GRAPH_BASE}/${path}`);
  if (fields) url.searchParams.set('fields', fields);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${pageAccessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
  try {
    return { ok: true, status: res.status, data: JSON.parse(body) as T };
  } catch {
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
}

/**
 * Resolve IG Business account from Graph and/or values saved in integration_meta
 * (manual IG ID entry when Page node omits instagram_business_account).
 */
async function resolveIgAccountForStatus(
  meta: IntegrationMeta,
  pageAccessToken: string,
): Promise<{
  pageId?: string;
  pageName?: string;
  ig?: ResolvedIgAccount;
  warnings: string[];
  tokenError?: string;
}> {
  const warnings: string[] = [];

  const me = await graphGet<{
    id?: string;
    name?: string;
    instagram_business_account?: { id?: string; username?: string; name?: string };
  }>('me', pageAccessToken, 'id,name,instagram_business_account{id,username,name}');

  if (!me.ok) {
    return {
      warnings,
      tokenError: `Page Access Token недійсний (${me.status}): ${me.body ?? 'помилка Graph API'}`,
    };
  }

  const pageIdFromMe = me.data?.id;
  const pageName = me.data?.name;
  let ig: ResolvedIgAccount | undefined;

  const fromMe = me.data?.instagram_business_account;
  if (fromMe?.id) {
    ig = {
      id: fromMe.id,
      username: fromMe.username,
      name: fromMe.name,
      source: 'graph_page',
    };
  }

  const pageId = meta.pageId || pageIdFromMe || '';
  if (!ig?.id && pageId) {
    const pageProbe = await graphGet<{
      id?: string;
      name?: string;
      instagram_business_account?: { id?: string; username?: string; name?: string };
    }>(pageId, pageAccessToken, 'id,name,instagram_business_account{id,username,name}');

    if (pageProbe.ok) {
      const fromPage = pageProbe.data?.instagram_business_account;
      if (fromPage?.id) {
        ig = {
          id: fromPage.id,
          username: fromPage.username,
          name: fromPage.name,
          source: 'graph_page',
        };
      }
    }
  }

  if (!ig?.id && meta.igUserId) {
    const igProbe = await graphGet<{ id?: string; username?: string; name?: string }>(
      meta.igUserId,
      pageAccessToken,
      'id,username,name',
    );

    if (igProbe.ok && igProbe.data?.id) {
      ig = {
        id: igProbe.data.id,
        username: igProbe.data.username ?? meta.igUsername ?? undefined,
        name: igProbe.data.name,
        source: 'graph_ig_node',
      };
      warnings.push(
        'Graph не повернув instagram_business_account на Page — підключення підтверджено за збереженим Instagram User ID.',
      );
    } else if (!igProbe.ok) {
      warnings.push(
        `Не вдалося перевірити збережений Instagram User ID ${meta.igUserId} (${igProbe.status}).`,
      );
    }
  }

  if (!ig?.id && meta.igUserId && meta.pageAccessToken) {
    ig = {
      id: meta.igUserId,
      username: meta.igUsername || undefined,
      source: 'configured',
    };
    warnings.push(
      'Instagram User ID взято з налаштувань без прямого підтвердження Graph — перевірте «Діагностика API» або надішліть тестовий DM.',
    );
  }

  if (ig?.id && meta.igUserId && ig.id !== meta.igUserId && ig.source === 'graph_page') {
    warnings.push(
      `Збережений Instagram User ID (${meta.igUserId}) відрізняється від Graph (${ig.id}). Рекомендуємо зберегти оновлені дані.`,
    );
  }

  if (pageId && pageIdFromMe && pageId !== pageIdFromMe) {
    warnings.push(
      `Збережений Page ID (${pageId}) відрізняється від токена (${pageIdFromMe}).`,
    );
  }

  return {
    pageId: pageId || pageIdFromMe,
    pageName,
    ig,
    warnings,
  };
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
 * Verifies Page Access Token, Instagram account (Graph or saved IDs), webhook
 * subscription, and optional conversations API access.
 */
export async function checkIgConnectionStatus(): Promise<IgConnectionStatus> {
  const { meta } = await getIntegrationConfig();

  if (!meta.pageAccessToken) {
    return {
      connected: false,
      error: 'Page Access Token відсутній — OAuth або вставте токен і збережіть Instagram',
    };
  }

  try {
    const resolved = await resolveIgAccountForStatus(meta, meta.pageAccessToken);
    if (resolved.tokenError) {
      return { connected: false, error: resolved.tokenError, warnings: resolved.warnings };
    }

    if (!resolved.ig?.id) {
      return {
        connected: false,
        error:
          'Не вдалося підтвердити Instagram Business акаунт. Вкажіть Instagram User ID вручну або повторіть OAuth.',
        page: resolved.pageId ? { id: resolved.pageId, name: resolved.pageName } : undefined,
        warnings: resolved.warnings,
      };
    }

    const pageId = resolved.pageId ?? meta.pageId;
    const warnings = [...resolved.warnings];

    let webhook: IgConnectionStatus['webhook'];
    if (pageId) {
      let sub = await getPageWebhookSubscription(pageId, meta.pageAccessToken);
      if (sub.ok && !sub.subscribed) {
        const fix = await subscribePageToMetaWebhooks(pageId, meta.pageAccessToken);
        if (fix.ok) {
          sub = await getPageWebhookSubscription(pageId, meta.pageAccessToken);
          if (sub.subscribed) {
            log.info({ pageId }, 'Webhook subscription restored during status check');
          }
        } else {
          warnings.push(
            `Webhook не підписано на Page (${fix.status ?? 'помилка'}). Callback: /webhooks/instagram`,
          );
        }
      }

      webhook = {
        subscribed: sub.subscribed,
        fields: sub.fields,
        ...(sub.ok && !sub.subscribed && sub.body ? { error: sub.body } : {}),
      };

      if (!sub.ok) {
        warnings.push(`Не вдалося перевірити webhook підписку (${sub.status ?? 'помилка'})`);
      } else if (!sub.subscribed) {
        warnings.push(
          'Page webhook не має усіх полів (messages, standby, …). Перевірте Meta Dashboard і OAuth.',
        );
      }
    } else {
      warnings.push('Page ID не задано — webhook і імпорт діалогів можуть не працювати.');
    }

    let conversationsCount: number | undefined;
    if (pageId) {
      const convUrl = new URL(`${FB_GRAPH_BASE}/${pageId}/conversations`);
      convUrl.searchParams.set('platform', 'instagram');
      convUrl.searchParams.set('limit', '5');
      convUrl.searchParams.set('fields', 'id,updated_time');
      const convRes = await fetch(convUrl.toString(), {
        headers: { Authorization: `Bearer ${meta.pageAccessToken}` },
        signal: AbortSignal.timeout(6_000),
      });
      if (convRes.ok) {
        const convData = (await convRes.json()) as { data?: unknown[] };
        conversationsCount = convData.data?.length ?? 0;
      } else if (resolved.ig.source === 'configured') {
        warnings.push(
          'API діалогів не відповів — при ручному IG ID це може бути нормально до першого вхідного DM.',
        );
      }
    }

    let business: IgConnectionStatus['business'];
    if (meta.userAccessToken) {
      try {
        const bizUrl = new URL(`${FB_GRAPH_BASE}/me/businesses`);
        bizUrl.searchParams.set('fields', 'id,name');
        const bizRes = await fetch(bizUrl.toString(), {
          headers: { Authorization: `Bearer ${meta.userAccessToken}` },
          signal: AbortSignal.timeout(6_000),
        });
        if (bizRes.ok) {
          const bizData = (await bizRes.json()) as { data?: Array<{ id: string; name: string }> };
          const first = bizData.data?.[0];
          if (first) business = { id: first.id, name: first.name };
        }
      } catch {
        // non-fatal
      }
    }

    if (resolved.ig.id && meta.facebookAppSecret) {
      syncWebhookRoutingToHub(
        resolved.ig.id,
        meta.facebookAppSecret,
        log,
        meta.pageAccessToken,
      );
    }

    return {
      connected: true,
      page: pageId ? { id: pageId, name: resolved.pageName } : undefined,
      igAccount: {
        id: resolved.ig.id,
        username: resolved.ig.username ?? meta.igUsername ?? undefined,
        name: resolved.ig.name,
        accountType: 'BUSINESS',
        source: resolved.ig.source,
      },
      webhook,
      ...(business && { business }),
      ...(conversationsCount !== undefined && { conversationsCount }),
      ...(warnings.length > 0 && { warnings }),
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
  // Facebook API returns ~2-3s per item when participants.username is requested.
  // Use small pages (5) and only fetch participant IDs (no username lookup).
  // Usernames are resolved separately via fetchIgUserProfile if needed.
  const pageSize = Math.min(5, target);

  const threads: IgConversationListItem[] = [];

  const firstUrl = new URL(`${FB_GRAPH_BASE}/${pageId}/conversations`);
  firstUrl.searchParams.set('platform', 'instagram');
  firstUrl.searchParams.set('fields', 'id,updated_time,participants{id}');
  firstUrl.searchParams.set('limit', String(pageSize));
  firstUrl.searchParams.set('sort', 'desc');

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
      signal: AbortSignal.timeout(30_000),
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

  // Facebook API returns the same thread multiple times (once per participant).
  // Deduplicate by conversation ID before processing.
  const seenIds = new Set<string>();
  const uniqueThreads = threads.filter((t) => {
    if (seenIds.has(t.id)) return false;
    seenIds.add(t.id);
    return true;
  });

  log.info(
    { raw: threads.length, unique: uniqueThreads.length, target, pageCount, emptyStreakDetected },
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

  for (const thread of uniqueThreads) {
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
