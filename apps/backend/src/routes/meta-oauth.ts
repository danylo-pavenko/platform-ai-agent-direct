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

// ── Instagram Business Login endpoints ───────────────────────────────────────
const IG_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_SHORT_URL = 'https://api.instagram.com/oauth/access_token';
const IG_TOKEN_LONG_URL = 'https://graph.instagram.com/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com/v25.0';

// Scopes for a sales/messaging bot: read profile + read & send DMs.
const IG_SCOPES = 'instagram_business_basic,instagram_business_manage_messages';

// Webhook fields we want the IG account subscribed to.
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
<head><meta charset="utf-8"><title>Instagram OAuth</title></head>
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
   * Authenticated. Returns the Instagram Business Login authorization URL.
   * App ID must already be saved in DB (appSecret is read in the callback).
   */
  app.get('/meta/oauth-init', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const { meta } = await getIntegrationConfig();

    if (!meta.instagramAppId) {
      return reply.code(400).send({ error: 'Instagram App ID не налаштовано' });
    }

    const state = generateState();
    const redirectUri = `${getApiBaseUrl()}/settings/meta/oauth-callback`;

    const url = new URL(IG_AUTHORIZE_URL);
    url.searchParams.set('client_id', meta.instagramAppId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', IG_SCOPES);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    // Meta's documented param name is `force_reauth`. We previously used
    // `force_authentication` which was silently ignored, so Instagram could
    // serve cached consent on repeat authorizations.
    url.searchParams.set('force_reauth', 'true');

    return { authUrl: url.toString() };
  });

  /**
   * GET /settings/meta/oauth-callback
   * Public — Instagram redirects here after the user authorizes.
   *   code → short-lived token → long-lived token (~60d)
   *   → /me for profile → subscribe webhook → save to DB
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
    if (!meta.instagramAppId || !meta.instagramAppSecret) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: 'Instagram App ID / Secret не налаштовано - збережіть їх перед авторизацією',
        }),
      );
    }

    const redirectUri = `${getApiBaseUrl()}/settings/meta/oauth-callback`;

    try {
      // Step 1 — exchange code for short-lived token (~1 hour)
      const shortForm = new URLSearchParams({
        client_id: meta.instagramAppId,
        client_secret: meta.instagramAppSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });

      const shortRes = await fetch(IG_TOKEN_SHORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: shortForm.toString(),
      });

      const shortData = (await shortRes.json()) as {
        access_token?: string;
        user_id?: number | string;
        error_message?: string;
        error_type?: string;
      };

      if (!shortRes.ok || !shortData.access_token) {
        throw new Error(
          shortData.error_message ?? `Short-token exchange failed: ${shortRes.status}`,
        );
      }

      const shortToken: string = shortData.access_token;

      // Step 2 — exchange for long-lived token (~60 days)
      const longUrl = new URL(IG_TOKEN_LONG_URL);
      longUrl.searchParams.set('grant_type', 'ig_exchange_token');
      longUrl.searchParams.set('client_secret', meta.instagramAppSecret);
      longUrl.searchParams.set('access_token', shortToken);

      const longRes = await fetch(longUrl.toString());
      const longData = (await longRes.json()) as {
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: { message?: string };
      };

      if (!longRes.ok || !longData.access_token) {
        throw new Error(
          longData.error?.message ?? `Long-token exchange failed: ${longRes.status}`,
        );
      }

      const longToken: string = longData.access_token;
      const expiresInSec = typeof longData.expires_in === 'number' ? longData.expires_in : 0;
      const expiresAtIso = expiresInSec
        ? new Date(Date.now() + expiresInSec * 1000).toISOString()
        : '';

      // Step 3 — fetch /me with `user_id` field to get the canonical
      // Instagram Professional Account ID (e.g. 17841456810522403). Meta's
      // `/me?fields=id` returns an app-scoped ID (e.g. 27103…) which does
      // NOT match webhook `entry.id` or `participants.data[].id`, so we
      // MUST use `user_id`. We still read `id` as a debug fallback.
      const meUrl = new URL(`${IG_GRAPH_BASE}/me`);
      meUrl.searchParams.set('fields', 'id,user_id,username,name,account_type');
      meUrl.searchParams.set('access_token', longToken);

      const meRes = await fetch(meUrl.toString());
      const meData = (await meRes.json()) as {
        id?: string;
        user_id?: string;
        username?: string;
        name?: string;
        account_type?: string;
        error?: { message?: string };
      };

      // Prefer user_id (IG Professional Account ID). Fall back to id only
      // if Meta didn't return user_id for some reason.
      const canonicalId = meData.user_id ?? meData.id;
      if (!meRes.ok || !canonicalId) {
        throw new Error(
          meData.error?.message ?? `Failed to fetch IG account info: ${meRes.status}`,
        );
      }

      const igUserId = String(canonicalId);
      const igUsername = meData.username ?? '';

      app.log.info(
        {
          canonicalId,
          alsoReturnedId: meData.id,
          usedField: meData.user_id ? 'user_id' : 'id',
        },
        'IG /me identity resolved',
      );

      // Step 4 — subscribe this IG account to webhook events via /me/subscribed_apps.
      // Using `me` keeps us independent of which ID format we'd have to pass.
      // Non-fatal: log a warning if it fails, user can still save and retry later.
      try {
        const subUrl = new URL(`${IG_GRAPH_BASE}/me/subscribed_apps`);
        subUrl.searchParams.set('subscribed_fields', WEBHOOK_FIELDS);
        subUrl.searchParams.set('access_token', longToken);

        const subRes = await fetch(subUrl.toString(), { method: 'POST' });
        if (!subRes.ok) {
          const body = await subRes.text().catch(() => '');
          app.log.warn(
            { status: subRes.status, body: body.slice(0, 300) },
            'IG webhook subscription failed (non-fatal)',
          );
        } else {
          app.log.info({ igUserId }, 'IG webhook subscribed successfully');
        }
      } catch (subErr) {
        app.log.warn({ err: subErr }, 'IG webhook subscription error (non-fatal)');
      }

      // Step 5 — persist tokens to DB so subsequent API calls work immediately.
      // We merge into existing integration_meta to preserve appId/appSecret/verifyToken.
      const existing = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
      const existingData = (existing?.value ?? {}) as Record<string, unknown>;

      const merged = {
        ...existingData,
        igUserId,
        igUsername,
        igAccessToken: longToken,
        igTokenExpiresAt: expiresAtIso,
      };

      await prisma.setting.upsert({
        where: { key: 'integration_meta' },
        create: { key: 'integration_meta', value: merged },
        update: { value: merged },
      });

      invalidateIntegrationConfigCache();

      app.log.info(
        { igUserId, igUsername, expiresAtIso },
        'Instagram OAuth completed and credentials saved',
      );

      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_success',
          account: {
            igUserId,
            igUsername,
            name: meData.name,
            accountType: meData.account_type,
            expiresAt: expiresAtIso,
          },
        }),
      );
    } catch (err: any) {
      app.log.error({ err }, 'Instagram OAuth callback error');
      return reply.send(
        buildPopupHtml({ type: 'meta_oauth_error', error: err.message ?? 'OAuth failed' }),
      );
    }
  });

  /**
   * GET /settings/meta/status
   * Verifies the saved IG access token is still valid and returns
   * the Instagram Business/Creator account info.
   */
  app.get('/meta/status', { onRequest: [app.authenticate] }, async () => {
    return checkIgConnectionStatus();
  });

  /**
   * GET /settings/meta/debug
   * Diagnostic: hits several Meta endpoints with the stored token and
   * returns raw responses (status, selected headers, body) so we can
   * see exactly what Instagram is saying without another deploy cycle.
   * Secrets are NOT included in the response.
   */
  app.get('/meta/debug', { onRequest: [app.authenticate] }, async () => {
    const { meta } = await getIntegrationConfig();
    if (!meta.igAccessToken) {
      return { error: 'Instagram access token не налаштовано' };
    }

    const probe = async (label: string, url: string) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const hdrs: Record<string, string> = {};
        for (const h of [
          'x-app-usage',
          'x-business-use-case-usage',
          'x-ad-account-usage',
          'x-fb-trace-id',
          'x-fb-rev',
        ]) {
          const v = res.headers.get(h);
          if (v) hdrs[h] = v;
        }
        return {
          label,
          url: url.replace(meta.igAccessToken, '«TOKEN»'),
          status: res.status,
          headers: hdrs,
          body: parsed ?? text.slice(0, 2000),
        };
      } catch (e: any) {
        return {
          label,
          url: url.replace(meta.igAccessToken, '«TOKEN»'),
          error: e.message ?? String(e),
        };
      }
    };

    const token = meta.igAccessToken;
    const ig = meta.igUserId;

    const results = await Promise.all([
      probe(
        '/me?fields=id,user_id,username,name,account_type',
        `${IG_GRAPH_BASE}/me?fields=id,user_id,username,name,account_type&access_token=${encodeURIComponent(token)}`,
      ),
      probe(
        '/me/conversations?platform=instagram&limit=3',
        `${IG_GRAPH_BASE}/me/conversations?platform=instagram&limit=3&fields=id,updated_time,participants&access_token=${encodeURIComponent(token)}`,
      ),
      ig
        ? probe(
            `/${ig}/conversations?platform=instagram&limit=3`,
            `${IG_GRAPH_BASE}/${ig}/conversations?platform=instagram&limit=3&fields=id,updated_time,participants&access_token=${encodeURIComponent(token)}`,
          )
        : Promise.resolve({ label: `/{igUserId}/conversations`, error: 'igUserId missing' }),
      probe(
        '/me/subscribed_apps',
        `${IG_GRAPH_BASE}/me/subscribed_apps?access_token=${encodeURIComponent(token)}`,
      ),
    ]);

    return {
      igUserId: meta.igUserId,
      igUsername: meta.igUsername,
      apiVersion: 'v25.0',
      probes: results,
    };
  });

  /**
   * POST /settings/meta/import-recent-conversations
   * Bulk-imports the last N Instagram conversations (default 20) into our DB.
   * Outgoing messages in threads with no bot history are classified as manager replies.
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
