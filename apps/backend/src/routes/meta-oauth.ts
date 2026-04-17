import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { config } from '../config.js';

// ── State store (in-memory, expires in 10 min) ───────────────────────────────
const pendingStates = new Map<string, { expiresAt: number }>();

function generateState(): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 });
  // Prune expired entries
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
   * Authenticated. Returns Facebook OAuth authorization URL.
   * ?appId= — the App ID to use (must be saved in DB already or passed here).
   */
  app.get<{ Querystring: { appId?: string } }>(
    '/meta/oauth-init',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const appId = (request.query.appId ?? '').trim();
      if (!appId) {
        return reply.code(400).send({ error: 'appId is required' });
      }

      const state = generateState();
      const redirectUri = `${getApiBaseUrl()}/settings/meta/oauth-callback`;

      const url = new URL('https://www.facebook.com/v19.0/dialog/oauth');
      url.searchParams.set('client_id', appId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set(
        'scope',
        'pages_messaging,instagram_basic,instagram_manage_messages,pages_read_engagement',
      );
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');

      return { authUrl: url.toString() };
    },
  );

  /**
   * GET /settings/meta/oauth-callback
   * Public — Facebook redirects here after user authorizes.
   * Exchanges code → short-lived token → long-lived token → pages list.
   * Sends result to opener via postMessage and closes the popup.
   */
  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
  }>(
    '/meta/oauth-callback',
    async (request, reply) => {
      const { code, state, error: fbError, error_description } = request.query;

      reply.type('text/html');

      if (fbError) {
        return reply.send(
          buildPopupHtml({ type: 'meta_oauth_error', error: error_description ?? fbError }),
        );
      }

      if (!code || !state) {
        return reply.send(
          buildPopupHtml({ type: 'meta_oauth_error', error: 'Missing code or state parameter' }),
        );
      }

      if (!consumeState(state)) {
        return reply.send(
          buildPopupHtml({ type: 'meta_oauth_error', error: 'Invalid or expired state — please try again' }),
        );
      }

      // App ID + Secret must be saved in DB before initiating OAuth
      const { meta } = await getIntegrationConfig();
      if (!meta.appId || !meta.appSecret) {
        return reply.send(
          buildPopupHtml({ type: 'meta_oauth_error', error: 'App ID / App Secret not configured — save them first' }),
        );
      }

      const redirectUri = `${getApiBaseUrl()}/settings/meta/oauth-callback`;

      try {
        // Step 1 — exchange code for short-lived user access token
        const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
        tokenUrl.searchParams.set('client_id', meta.appId);
        tokenUrl.searchParams.set('client_secret', meta.appSecret);
        tokenUrl.searchParams.set('redirect_uri', redirectUri);
        tokenUrl.searchParams.set('code', code);

        const tokenRes = await fetch(tokenUrl.toString());
        const tokenData = (await tokenRes.json()) as any;
        if (tokenData.error) throw new Error(tokenData.error.message);
        const shortToken: string = tokenData.access_token;

        // Step 2 — exchange for long-lived user access token (~60 days)
        const llUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
        llUrl.searchParams.set('grant_type', 'fb_exchange_token');
        llUrl.searchParams.set('client_id', meta.appId);
        llUrl.searchParams.set('client_secret', meta.appSecret);
        llUrl.searchParams.set('fb_exchange_token', shortToken);

        const llRes = await fetch(llUrl.toString());
        const llData = (await llRes.json()) as any;
        if (llData.error) throw new Error(llData.error.message);
        const longToken: string = llData.access_token;

        // Step 3 — get managed pages (page tokens derived from long-lived token are also long-lived)
        const pagesRes = await fetch(
          `https://graph.facebook.com/v19.0/me/accounts?` +
            new URLSearchParams({ access_token: longToken, fields: 'id,name,access_token' }),
        );
        const pagesData = (await pagesRes.json()) as any;
        if (pagesData.error) throw new Error(pagesData.error.message);

        const pages: Array<{ id: string; name: string; access_token: string }> = (
          pagesData.data ?? []
        ).map((p: any) => ({
          id: String(p.id),
          name: String(p.name),
          access_token: String(p.access_token),
        }));

        if (pages.length === 0) {
          return reply.send(
            buildPopupHtml({
              type: 'meta_oauth_error',
              error:
                'Не знайдено Facebook-сторінок для цього акаунту. Переконайтесь, що акаунт є адміном сторінки, підключеної до Instagram.',
            }),
          );
        }

        app.log.info({ pageCount: pages.length }, 'Meta OAuth: pages retrieved');

        return reply.send(
          buildPopupHtml({
            type: 'meta_oauth_success',
            pages: pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })),
          }),
        );
      } catch (err: any) {
        app.log.error({ err }, 'Meta OAuth callback error');
        return reply.send(
          buildPopupHtml({ type: 'meta_oauth_error', error: err.message ?? 'OAuth failed' }),
        );
      }
    },
  );
}
