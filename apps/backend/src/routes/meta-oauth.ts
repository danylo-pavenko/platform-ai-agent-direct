import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import {
  getIntegrationConfig,
  invalidateIntegrationConfigCache,
} from '../lib/integration-config.js';
import { config } from '../config.js';
import {
  checkIgConnectionStatus,
  importRecentIgConversations,
} from '../services/ig-connection.js';

// ── Facebook Login for Business endpoints ────────────────────────────────────
const FB_AUTHORIZE_URL = 'https://www.facebook.com/dialog/oauth';
const FB_TOKEN_URL = 'https://graph.facebook.com/oauth/access_token';
const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

// Scopes for Instagram Business messaging via Facebook Login (align with App Review).
// instagram_basic is intentionally omitted: it belongs to the deprecated
// Instagram Basic Display API (personal accounts) and is wrong for Messenger
// Platform / Business Messaging.
// pages_manage_metadata is NOT a valid Facebook Login OAuth scope (Meta rejects it);
// webhook subscription (POST /{page-id}/subscribed_apps) works without it when
// the authorizing user is the Page admin.
const FB_SCOPES = [
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'pages_messaging',
  'instagram_manage_messages',
  'instagram_business_basic',
].join(',');

// Webhook fields we want the Page subscribed to.
// `standby` is required when another messaging app (Business Suite, another bot, etc.)
// owns the thread: Meta delivers the customer's new messages there instead of `messaging`.
const WEBHOOK_FIELDS = 'messages,messaging_postbacks,messaging_seen,standby';

// ── State store (in-memory, expires in 10 min) ───────────────────────────────
const pendingStates = new Map<string, { expiresAt: number }>();

function generateState(): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 });
  for (const [k, v] of pendingStates) {
    if (v.expiresAt < Date.now()) pendingStates.delete(k);
  }
  return state;
}

function consumeState(state: string): boolean {
  const entry = pendingStates.get(state);
  if (!entry || entry.expiresAt < Date.now()) return false;
  pendingStates.delete(state);
  return true;
}

function getApiBaseUrl(): string {
  if (config.API_DOMAIN === 'localhost') {
    return `http://localhost:${config.API_PORT}`;
  }
  return `https://${config.API_DOMAIN}`;
}

interface MetaPageRow {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}

/** Safe page list for logs — never includes access_token. */
function summarizePagesList(pages: MetaPageRow[]) {
  return pages.map((p) => ({
    pageId: p.id,
    pageName: p.name,
    hasInstagram: Boolean(p.instagram_business_account?.id),
    igUserId: p.instagram_business_account?.id ?? null,
    igUsername: p.instagram_business_account?.username ?? null,
  }));
}

const PAGE_LIST_FIELDS =
  'id,name,access_token,instagram_business_account{id,username,name}';
const PAGE_IG_FIELDS = 'instagram_business_account{id,username,name}';

/** Graph debug_token — scopes / validity (no secret values). */
async function debugFacebookToken(
  inputToken: string,
  appId: string,
  appSecret: string,
): Promise<Record<string, unknown>> {
  try {
    const debugUrl = new URL(`${FB_GRAPH_BASE}/debug_token`);
    debugUrl.searchParams.set('input_token', inputToken);
    debugUrl.searchParams.set('access_token', `${appId}|${appSecret}`);
    const res = await fetch(debugUrl.toString(), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return { httpStatus: res.status };
    }
    const json = (await res.json()) as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    return {
      isValid: d.is_valid,
      type: d.type,
      appId: d.app_id,
      userId: d.user_id,
      expiresAt: d.expires_at,
      scopes: d.scopes,
      granularScopes: d.granular_scopes,
      error: d.error,
    };
  } catch (err) {
    return { probeError: err instanceof Error ? err.message : String(err) };
  }
}

async function probePageInstagram(
  pageId: string,
  userAccessToken: string,
): Promise<MetaPageRow['instagram_business_account'] | undefined> {
  const url = new URL(`${FB_GRAPH_BASE}/${pageId}`);
  url.searchParams.set('fields', PAGE_IG_FIELDS);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      instagram_business_account?: MetaPageRow['instagram_business_account'];
    };
    return data.instagram_business_account?.id ? data.instagram_business_account : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Meta sometimes omits instagram_business_account on /me/accounts batch responses
 * even when the Page↔IG link exists. Probe each Page directly, then scan Business
 * Portfolio pages (requires business_management — already in our OAuth scopes).
 */
async function resolvePagesWithInstagram(
  pages: MetaPageRow[],
  userAccessToken: string,
): Promise<{ pages: MetaPageRow[]; businessOnlyPages: Array<{ id: string; name: string; igUsername: string | null }> }> {
  const byId = new Map<string, MetaPageRow>(pages.map((p) => [p.id, { ...p }]));

  for (const p of byId.values()) {
    if (p.instagram_business_account?.id) continue;
    const ig = await probePageInstagram(p.id, userAccessToken);
    if (ig?.id) p.instagram_business_account = ig;
  }

  const businessOnlyPages: Array<{ id: string; name: string; igUsername: string | null }> = [];

  try {
    const bizUrl = new URL(`${FB_GRAPH_BASE}/me/businesses`);
    bizUrl.searchParams.set('fields', 'id,name');
    const bizRes = await fetch(bizUrl.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const bizData = (await bizRes.json()) as { data?: Array<{ id: string; name: string }> };

    for (const biz of bizData.data ?? []) {
      for (const edge of ['owned_pages', 'client_pages'] as const) {
        const edgeUrl = new URL(`${FB_GRAPH_BASE}/${biz.id}/${edge}`);
        edgeUrl.searchParams.set('fields', `id,name,${PAGE_IG_FIELDS}`);
        const edgeRes = await fetch(edgeUrl.toString(), {
          headers: { Authorization: `Bearer ${userAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!edgeRes.ok) continue;
        const edgeData = (await edgeRes.json()) as { data?: MetaPageRow[] };
        for (const row of edgeData.data ?? []) {
          const ig = row.instagram_business_account;
          const existing = byId.get(row.id);
          if (existing) {
            if (!existing.instagram_business_account?.id && ig?.id) {
              existing.instagram_business_account = ig;
            }
          } else if (ig?.id) {
            businessOnlyPages.push({
              id: row.id,
              name: row.name,
              igUsername: ig.username ?? null,
            });
          }
        }
      }
    }
  } catch {
    /* non-fatal enrichment */
  }

  return { pages: [...byId.values()], businessOnlyPages };
}

const IG_RELATED_SCOPES = new Set([
  'instagram_manage_messages',
  'instagram_business_manage_messages',
  'instagram_basic',
  'instagram_business_basic',
]);

/** IG account IDs the user explicitly selected in the granular OAuth dialog. */
function extractIgTargetIdsFromTokenDebug(tokenDebug: Record<string, unknown>): string[] {
  const granular = tokenDebug.granularScopes;
  if (!Array.isArray(granular)) return [];
  const ids = new Set<string>();
  for (const row of granular) {
    if (!row || typeof row !== 'object') continue;
    const scope = String((row as { scope?: string }).scope ?? '');
    if (!IG_RELATED_SCOPES.has(scope) && !scope.startsWith('instagram')) continue;
    const targets = (row as { target_ids?: string[] }).target_ids;
    if (Array.isArray(targets)) {
      for (const id of targets) {
        if (typeof id === 'string' && id.length > 0) ids.add(id);
      }
    }
  }
  return [...ids];
}

async function listInstagramAccountIdsFromBusinesses(userAccessToken: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const bizUrl = new URL(`${FB_GRAPH_BASE}/me/businesses`);
    bizUrl.searchParams.set('fields', 'id');
    const bizRes = await fetch(bizUrl.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!bizRes.ok) return [];
    const bizData = (await bizRes.json()) as { data?: Array<{ id: string }> };

    for (const biz of bizData.data ?? []) {
      for (const edge of [
        'owned_instagram_accounts',
        'instagram_accounts',
        'client_instagram_accounts',
      ] as const) {
        const edgeUrl = new URL(`${FB_GRAPH_BASE}/${biz.id}/${edge}`);
        edgeUrl.searchParams.set('fields', 'id,username');
        const edgeRes = await fetch(edgeUrl.toString(), {
          headers: { Authorization: `Bearer ${userAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!edgeRes.ok) continue;
        const edgeData = (await edgeRes.json()) as { data?: Array<{ id: string }> };
        for (const ig of edgeData.data ?? []) {
          if (ig.id) ids.add(ig.id);
        }
      }
    }
  } catch {
    /* non-fatal */
  }
  return [...ids];
}

async function fetchIgUserConnectedPage(
  igUserId: string,
  userAccessToken: string,
): Promise<{
  igUserId: string;
  igUsername?: string;
  pageId?: string;
  pageName?: string;
  httpStatus?: number;
  graphError?: string;
} | null> {
  const url = new URL(`${FB_GRAPH_BASE}/${igUserId}`);
  url.searchParams.set('fields', 'id,username,name,connected_facebook_page{id,name}');
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      id?: string;
      username?: string;
      connected_facebook_page?: { id?: string; name?: string };
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        igUserId,
        httpStatus: res.status,
        graphError: data.error?.message,
      };
    }
    return {
      igUserId,
      igUsername: data.username,
      pageId: data.connected_facebook_page?.id,
      pageName: data.connected_facebook_page?.name,
    };
  } catch {
    return null;
  }
}

/**
 * When the user picks Instagram accounts in the OAuth dialog (your screenshot),
 * Graph often still omits instagram_business_account on /me/accounts. Resolve via
 * debug_token target_ids → IG node → connected_facebook_page → Page access_token.
 */
async function resolvePageFromSelectedInstagramAccounts(
  userAccessToken: string,
  pages: MetaPageRow[],
  tokenDebug: Record<string, unknown>,
): Promise<MetaPageRow | null> {
  let igIds = extractIgTargetIdsFromTokenDebug(tokenDebug);
  if (igIds.length === 0) {
    igIds = await listInstagramAccountIdsFromBusinesses(userAccessToken);
  }

  for (const igUserId of igIds) {
    const linked = await fetchIgUserConnectedPage(igUserId, userAccessToken);
    if (!linked?.pageId) continue;

    const pageRow = pages.find((p) => p.id === linked.pageId);
    if (!pageRow?.access_token) continue;

    return {
      ...pageRow,
      instagram_business_account: {
        id: igUserId,
        username: linked.igUsername,
      },
    };
  }
  return null;
}

function buildOAuthNoIgError(
  pages: MetaPageRow[],
  businessOnlyPages: Array<{ id: string; name: string; igUsername: string | null }>,
): string {
  const names = pages.map((p) => `«${p.name}»`).join(', ') || '—';
  let msg =
    `Facebook повернув ${pages.length} сторінок (${names}), але на жодній Graph API не бачить підключений Instagram Business. `;

  if (businessOnlyPages.length > 0) {
    const bm = businessOnlyPages
      .map((p) => `«${p.name}»${p.igUsername ? ` (@${p.igUsername})` : ''}`)
      .join(', ');
    msg +=
      `У Business Manager знайдені інші сторінки з Instagram (${bm}), але до них немає доступу в цьому OAuth — ` +
      'увійдіть акаунтом-адміном цієї Page і в вікні Facebook натисніть «Змінити налаштування» / «Изменить настройки», щоб дозволити потрібну сторінку. ';
  } else {
    msg +=
      'Ймовірно, ви ввійшли не тим Facebook-профілем або не обрали потрібну Page у діалозі дозволів. ';
  }

  msg +=
    'Якщо в OAuth ви вже обрали Instagram-акаунт (крок «Аккаунты Instagram»), але помилка лишається — оновіть код на сервері або зверніться до підтримки: потрібен резолв через connected_facebook_page. ';
  msg +=
    'Також перевірте в Business Suite: Instagram Professional привʼязаний до Facebook Page, а в OAuth дозволені і Page, і Instagram.';
  return msg;
}

function buildPopupHtml(message: Record<string, unknown>): string {
  const json = JSON.stringify(message);
  return `<!DOCTYPE html>
<html lang="uk">
<head><meta charset="utf-8"><title>Facebook OAuth</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;color:#555">
<p>Обробляємо авторизацію...</p>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage(${json}, '*');
    }
  } catch (e) {}
  setTimeout(function() { window.close(); }, 400);
<\/script>
</body>
</html>`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function metaOAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /settings/meta/oauth-init
   * Authenticated. Returns the Facebook Login authorization URL.
   * App ID must already be saved in DB (appSecret is read in the callback).
   */
  app.get('/meta/oauth-init', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const { meta } = await getIntegrationConfig();

    if (!meta.facebookAppId) {
      return reply.code(400).send({ error: 'Facebook App ID не налаштовано' });
    }

    const state = generateState();
    const redirectUri = `${getApiBaseUrl()}/settings/meta/oauth-callback`;

    const url = new URL(FB_AUTHORIZE_URL);
    url.searchParams.set('client_id', meta.facebookAppId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', FB_SCOPES);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return { authUrl: url.toString() };
  });

  /**
   * GET /settings/meta/oauth-callback
   * Public — Facebook redirects here after the user authorizes.
   *   code → User Access Token → Page list → Page Access Token
   *   → subscribe webhook → save pageId + pageAccessToken + igUserId to DB
   * Sends result to opener via postMessage and closes the popup.
   */
  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      error_reason?: string;
    };
  }>('/meta/oauth-callback', async (request, reply) => {
    const { code, state, error: fbError, error_description, error_reason } = request.query;

    reply.type('text/html');

    if (fbError) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: error_description ?? error_reason ?? fbError,
        }),
      );
    }

    if (!code || !state) {
      return reply.send(
        buildPopupHtml({ type: 'meta_oauth_error', error: 'Missing code or state parameter' }),
      );
    }

    if (!consumeState(state)) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: 'Invalid or expired state - please try again',
        }),
      );
    }

    const { meta } = await getIntegrationConfig();
    if (!meta.facebookAppId || !meta.facebookAppSecret) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: 'Facebook App ID / Secret не налаштовано - збережіть їх перед авторизацією',
        }),
      );
    }

    const redirectUri = `${getApiBaseUrl()}/settings/meta/oauth-callback`;

    try {
      // Step 1 — exchange code for User Access Token
      const tokenUrl = new URL(FB_TOKEN_URL);
      tokenUrl.searchParams.set('client_id', meta.facebookAppId);
      tokenUrl.searchParams.set('client_secret', meta.facebookAppSecret);
      tokenUrl.searchParams.set('redirect_uri', redirectUri);
      tokenUrl.searchParams.set('code', code);

      const tokenRes = await fetch(tokenUrl.toString(), {
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: { message?: string };
      };

      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(
          tokenData.error?.message ?? `Token exchange failed: ${tokenRes.status}`,
        );
      }

      const userAccessToken = tokenData.access_token;
      app.log.info(
        {
          expiresIn: tokenData.expires_in ?? null,
          tokenType: tokenData.token_type ?? null,
        },
        'Facebook OAuth: user access token obtained',
      );

      // Step 2 — get Pages the user manages, with their Instagram Business Accounts.
      // We need both the Page Access Token and the connected IG account ID.
      const pagesUrl = new URL(`${FB_GRAPH_BASE}/me/accounts`);
      pagesUrl.searchParams.set('fields', PAGE_LIST_FIELDS);

      const pagesRes = await fetch(pagesUrl.toString(), {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const pagesData = (await pagesRes.json()) as {
        data?: MetaPageRow[];
        paging?: { next?: string };
        error?: { message?: string; type?: string; code?: number };
      };

      if (!pagesRes.ok || !pagesData.data) {
        app.log.warn(
          {
            httpStatus: pagesRes.status,
            graphError: pagesData.error?.message,
            graphErrorType: pagesData.error?.type,
            graphErrorCode: pagesData.error?.code,
          },
          'Facebook OAuth: /me/accounts request failed',
        );
        throw new Error(
          pagesData.error?.message ?? `Failed to fetch pages: ${pagesRes.status}`,
        );
      }

      const pagesSummary = summarizePagesList(pagesData.data);
      app.log.debug(
        {
          pageCount: pagesData.data.length,
          pagesWithInstagram: pagesSummary.filter((p) => p.hasInstagram).length,
          pages: pagesSummary,
          hasPagingNext: Boolean(pagesData.paging?.next),
        },
        'Facebook OAuth: /me/accounts response',
      );

      const { pages: resolvedPages, businessOnlyPages } = await resolvePagesWithInstagram(
        pagesData.data,
        userAccessToken,
      );
      const resolvedSummary = summarizePagesList(resolvedPages);
      if (resolvedSummary.some((p) => p.hasInstagram) && !pagesSummary.some((p) => p.hasInstagram)) {
        app.log.info(
          { pages: resolvedSummary.filter((p) => p.hasInstagram) },
          'Facebook OAuth: instagram_business_account resolved via per-page / Business Portfolio probe',
        );
      }
      if (businessOnlyPages.length > 0) {
        app.log.warn(
          { businessOnlyPages },
          'Facebook OAuth: IG-linked pages visible in Business Manager but not granted in /me/accounts',
        );
      }

      // Pick the first page that has a connected Instagram Business Account
      let pageWithIg = resolvedPages.find(
        (p) => p.instagram_business_account?.id && p.access_token,
      );

      const tokenDebug =
        pageWithIg
          ? null
          : await debugFacebookToken(
              userAccessToken,
              meta.facebookAppId,
              meta.facebookAppSecret,
            );

      if (!pageWithIg && tokenDebug) {
        const igTargetIds = extractIgTargetIdsFromTokenDebug(tokenDebug);

        pageWithIg =
          (await resolvePageFromSelectedInstagramAccounts(
            userAccessToken,
            resolvedPages,
            tokenDebug,
          )) ?? undefined;

        if (pageWithIg) {
          app.log.info(
            {
              pageId: pageWithIg.id,
              pageName: pageWithIg.name,
              igUserId: pageWithIg.instagram_business_account?.id,
              igUsername: pageWithIg.instagram_business_account?.username,
              igTargetIds,
              via: 'granular_ig_selection_connected_facebook_page',
            },
            'Facebook OAuth: resolved Page+IG via selected Instagram account',
          );
        } else {
          const granularResolveAttempts: Array<Record<string, unknown>> = [];
          for (const igId of igTargetIds.length > 0
            ? igTargetIds
            : await listInstagramAccountIdsFromBusinesses(userAccessToken)) {
            const probe = await fetchIgUserConnectedPage(igId, userAccessToken);
            if (probe) granularResolveAttempts.push(probe);
          }
          app.log.warn(
            {
              pageCount: resolvedPages.length,
              pagesWithInstagram: resolvedSummary.filter((p) => p.hasInstagram).length,
              pages: resolvedSummary,
              businessOnlyPages,
              hasPagingNext: Boolean(pagesData.paging?.next),
              requestedScopes: FB_SCOPES,
              tokenDebug,
              igTargetIds,
              granularResolveAttempts,
            },
            'Facebook OAuth: no Page with linked Instagram Business account',
          );
          throw new Error(buildOAuthNoIgError(resolvedPages, businessOnlyPages));
        }
      }

      if (!pageWithIg?.access_token || !pageWithIg.instagram_business_account?.id) {
        throw new Error('Facebook OAuth: internal error resolving Page + Instagram');
      }

      const pageId = pageWithIg.id;
      const pageAccessToken = pageWithIg.access_token;
      const igUserId = pageWithIg.instagram_business_account!.id;
      const igUsername = pageWithIg.instagram_business_account!.username ?? '';
      const pageName = pageWithIg.name;

      app.log.info(
        { pageId, pageName, igUserId, igUsername },
        'Facebook OAuth: page + IG account resolved',
      );

      // Step 3 — subscribe this Page to webhook events.
      // Non-fatal: log a warning if it fails, user can retry via reconnect.
      try {
        const subUrl = new URL(`${FB_GRAPH_BASE}/${pageId}/subscribed_apps`);
        subUrl.searchParams.set('subscribed_fields', WEBHOOK_FIELDS);

        const subRes = await fetch(subUrl.toString(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${pageAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!subRes.ok) {
          const body = await subRes.text().catch(() => '');
          app.log.warn(
            { status: subRes.status, body: body.slice(0, 300) },
            'Page webhook subscription failed (non-fatal)',
          );
        } else {
          app.log.info({ pageId }, 'Page webhook subscribed successfully');
        }
      } catch (subErr) {
        app.log.warn({ err: subErr }, 'Page webhook subscription error (non-fatal)');
      }

      // Step 4 — persist to DB, merging into existing integration_meta to preserve
      // facebookAppId / facebookAppSecret / verifyToken.
      const existing = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
      const existingData = (existing?.value ?? {}) as Record<string, unknown>;

      const merged = {
        ...existingData,
        pageId,
        pageAccessToken,
        userAccessToken,
        igUserId,
        igUsername,
      };

      await prisma.setting.upsert({
        where: { key: 'integration_meta' },
        create: { key: 'integration_meta', value: merged },
        update: { value: merged },
      });

      invalidateIntegrationConfigCache();

      app.log.info(
        { pageId, pageName, igUserId, igUsername },
        'Facebook OAuth completed and credentials saved',
      );

      // Step 5 — auto-sync instagramUserId + facebookAppSecret to the platform hub
      // so the central webhook dispatcher can route events to this tenant without
      // manual super-admin configuration.
      if (config.SA_INTERNAL_URL && config.INSTANCE_ID && config.SUPERVISOR_SHARED_SECRET) {
        const syncUrl = `${config.SA_INTERNAL_URL}/api/tenants/by-instance/${config.INSTANCE_ID}/webhook-config`;
        fetch(syncUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET,
          },
          body: JSON.stringify({
            instagramUserId: igUserId,
            facebookAppSecret: meta.facebookAppSecret,
          }),
          signal: AbortSignal.timeout(8_000),
        })
          .then(async (res) => {
            if (res.ok) {
              app.log.info({ igUserId }, 'Webhook config auto-synced to platform hub');
            } else {
              const txt = await res.text().catch(() => '');
              app.log.warn({ status: res.status, body: txt.slice(0, 200) }, 'Hub webhook-config sync failed');
            }
          })
          .catch((err) => {
            app.log.warn({ err }, 'Hub webhook-config sync error (non-fatal)');
          });
      }

      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_success',
          account: {
            pageId,
            pageName,
            igUserId,
            igUsername,
          },
        }),
      );
    } catch (err: any) {
      app.log.error({ err }, 'Facebook OAuth callback error');
      return reply.send(
        buildPopupHtml({ type: 'meta_oauth_error', error: err.message ?? 'OAuth failed' }),
      );
    }
  });

  /**
   * GET /settings/meta/status
   * Verifies the saved Page Access Token is still valid and returns
   * the connected Instagram Business account info.
   */
  app.get('/meta/status', { onRequest: [app.authenticate] }, async () => {
    return checkIgConnectionStatus();
  });

  /**
   * GET /settings/meta/debug
   * Diagnostic: hits several Facebook/Instagram Graph API endpoints with the
   * stored Page token and returns raw responses.
   */
  app.get('/meta/debug', { onRequest: [app.authenticate] }, async () => {
    const { meta } = await getIntegrationConfig();
    if (!meta.pageAccessToken) {
      return { error: 'Facebook авторизацію не виконано — натисніть «Авторизуватись через Facebook»' };
    }

    const token = meta.pageAccessToken;
    const pageId = meta.pageId;
    const igUserId = meta.igUserId;

    const probe = async (
      label: string,
      url: string,
      opts: { auth?: 'query' | 'bearer' } = {},
    ) => {
      const auth = opts.auth ?? 'bearer';
      const finalUrl = new URL(url);
      if (auth === 'query') {
        finalUrl.searchParams.set('access_token', token);
      }
      const headers: Record<string, string> = {};
      if (auth === 'bearer') {
        headers.Authorization = `Bearer ${token}`;
      }
      try {
        const res = await fetch(finalUrl.toString(), {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const hdrs: Record<string, string> = {};
        for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-fb-trace-id', 'x-fb-rev']) {
          const v = res.headers.get(h);
          if (v) hdrs[h] = v;
        }
        return {
          label,
          auth,
          url: finalUrl.toString().replace(token, '«TOKEN»'),
          status: res.status,
          headers: hdrs,
          body: parsed ?? text.slice(0, 2000),
        };
      } catch (e: any) {
        return {
          label,
          auth,
          url: finalUrl.toString().replace(token, '«TOKEN»'),
          error: e.message ?? String(e),
        };
      }
    };

    const probes = await Promise.all([
      // Page info + connected IG account
      probe(
        '/me?fields=id,name,instagram_business_account (Bearer)',
        `${FB_GRAPH_BASE}/me?fields=id,name,instagram_business_account{id,username,name}`,
      ),
      // Conversations via pageId
      pageId
        ? probe(
            `/${pageId}/conversations?platform=instagram (Bearer)`,
            `${FB_GRAPH_BASE}/${pageId}/conversations?platform=instagram&limit=3&fields=id,updated_time,participants`,
          )
        : Promise.resolve({ label: 'conversations', error: 'pageId not set' }),
      // Webhook subscriptions
      pageId
        ? probe(
            `/${pageId}/subscribed_apps (Bearer)`,
            `${FB_GRAPH_BASE}/${pageId}/subscribed_apps`,
          )
        : Promise.resolve({ label: 'subscribed_apps', error: 'pageId not set' }),
      // IG account details
      igUserId
        ? probe(
            `/${igUserId}?fields=id,username,name (Bearer)`,
            `${FB_GRAPH_BASE}/${igUserId}?fields=id,username,name`,
          )
        : Promise.resolve({ label: 'ig_account', error: 'igUserId not set' }),
    ]);

    // debug_token — shows actual scopes on the page token
    let tokenDebug: unknown = null;
    if (meta.facebookAppId && meta.facebookAppSecret) {
      try {
        const appToken = `${meta.facebookAppId}|${meta.facebookAppSecret}`;
        const debugUrl = new URL('https://graph.facebook.com/v25.0/debug_token');
        debugUrl.searchParams.set('input_token', token);
        debugUrl.searchParams.set('access_token', appToken);
        const dtRes = await fetch(debugUrl.toString(), { signal: AbortSignal.timeout(8_000) });
        const dtText = await dtRes.text();
        try {
          tokenDebug = JSON.parse(dtText);
        } catch {
          tokenDebug = dtText.slice(0, 2000);
        }
      } catch (e: any) {
        tokenDebug = { error: e.message ?? String(e) };
      }
    }

    return {
      pageId,
      igUserId,
      igUsername: meta.igUsername,
      apiVersion: 'v22.0 (graph.facebook.com)',
      tokenDebug,
      probes,
    };
  });

  /**
   * POST /settings/meta/disconnect
   * Unlinks the connected Facebook Page / Instagram account:
   *   1. best-effort unsubscribe the Page from webhook events
   *   2. clear connection fields in integration_meta (pageId, tokens, IG ids)
   *   3. best-effort clear instagramUserId routing on the platform hub
   * Conversations and other settings are left intact.
   */
  app.post('/meta/disconnect', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const { meta } = await getIntegrationConfig();

    if (!meta.pageId && !meta.pageAccessToken && !meta.igUserId) {
      return reply.code(400).send({ error: 'Instagram не підключено — нічого відвʼязувати' });
    }

    // Step 1 — unsubscribe Page from webhook events (non-fatal).
    if (meta.pageId && meta.pageAccessToken) {
      try {
        const unsubRes = await fetch(`${FB_GRAPH_BASE}/${meta.pageId}/subscribed_apps`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${meta.pageAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!unsubRes.ok) {
          const body = await unsubRes.text().catch(() => '');
          app.log.warn(
            { status: unsubRes.status, body: body.slice(0, 300) },
            'Page webhook unsubscribe failed (non-fatal)',
          );
        } else {
          app.log.info({ pageId: meta.pageId }, 'Page webhook unsubscribed');
        }
      } catch (unsubErr) {
        app.log.warn({ err: unsubErr }, 'Page webhook unsubscribe error (non-fatal)');
      }
    }

    // Step 2 — clear connection fields in integration_meta, preserving the rest.
    const existing = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
    const existingData = (existing?.value ?? {}) as Record<string, unknown>;

    const merged = {
      ...existingData,
      pageId: '',
      pageAccessToken: '',
      userAccessToken: '',
      igUserId: '',
      igUsername: '',
    };

    await prisma.setting.upsert({
      where: { key: 'integration_meta' },
      create: { key: 'integration_meta', value: merged },
      update: { value: merged },
    });

    invalidateIntegrationConfigCache();

    app.log.info(
      { pageId: meta.pageId, igUserId: meta.igUserId, igUsername: meta.igUsername },
      'Instagram connection removed',
    );

    // Step 3 — clear webhook routing on the platform hub (non-fatal) so the
    // IG account can be re-connected by this or another tenant later.
    if (config.SA_INTERNAL_URL && config.INSTANCE_ID && config.SUPERVISOR_SHARED_SECRET) {
      const syncUrl = `${config.SA_INTERNAL_URL}/api/tenants/by-instance/${config.INSTANCE_ID}/webhook-config`;
      fetch(syncUrl, {
        method: 'DELETE',
        headers: { 'X-Supervisor-Token': config.SUPERVISOR_SHARED_SECRET },
        signal: AbortSignal.timeout(8_000),
      })
        .then(async (res) => {
          if (res.ok) {
            app.log.info('Webhook config cleared on platform hub');
          } else {
            const txt = await res.text().catch(() => '');
            app.log.warn({ status: res.status, body: txt.slice(0, 200) }, 'Hub webhook-config clear failed');
          }
        })
        .catch((err) => {
          app.log.warn({ err }, 'Hub webhook-config clear error (non-fatal)');
        });
    }

    return { ok: true };
  });

  /**
   * POST /settings/meta/import-recent-conversations
   * Bulk-imports the last N Instagram conversations (default 20) into our DB.
   */
  app.post<{ Body: { limit?: number } }>(
    '/meta/import-recent-conversations',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const limit = Math.max(1, Math.min(500, Number(request.body?.limit) || 20));

      try {
        const result = await importRecentIgConversations(limit);
        return result;
      } catch (err: any) {
        app.log.error({ err }, 'Failed to import recent IG conversations');
        return reply
          .code(500)
          .send({ error: err.message ?? 'Не вдалося завантажити розмови' });
      }
    },
  );
}
