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
const FB_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

// Scopes for Instagram Business messaging via Facebook Login.
const FB_SCOPES = 'instagram_basic,instagram_manage_messages,pages_messaging,pages_read_engagement,pages_show_list,business_management';

// Webhook fields we want the Page subscribed to.
const WEBHOOK_FIELDS = 'messages,messaging_postbacks,messaging_seen';

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

      // Step 2 — get Pages the user manages, with their Instagram Business Accounts.
      // We need both the Page Access Token and the connected IG account ID.
      const pagesUrl = new URL(`${FB_GRAPH_BASE}/me/accounts`);
      pagesUrl.searchParams.set(
        'fields',
        'id,name,access_token,instagram_business_account{id,username,name}',
      );

      const pagesRes = await fetch(pagesUrl.toString(), {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const pagesData = (await pagesRes.json()) as {
        data?: Array<{
          id: string;
          name: string;
          access_token: string;
          instagram_business_account?: { id: string; username?: string; name?: string };
        }>;
        error?: { message?: string };
      };

      if (!pagesRes.ok || !pagesData.data) {
        throw new Error(
          pagesData.error?.message ?? `Failed to fetch pages: ${pagesRes.status}`,
        );
      }

      // Pick the first page that has a connected Instagram Business Account
      const pageWithIg = pagesData.data.find((p) => p.instagram_business_account?.id);
      if (!pageWithIg) {
        throw new Error(
          'Не знайдено Facebook Сторінку з підключеним Instagram Business акаунтом. ' +
          'Переконайтесь що сторінка підключена до Instagram Business у Business Manager.',
        );
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
        const debugUrl = new URL('https://graph.facebook.com/v22.0/debug_token');
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
