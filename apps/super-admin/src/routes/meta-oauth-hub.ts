import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { parseHubOAuthState } from '../lib/meta-oauth-hub-state.js';

function buildErrorHtml(message: string): string {
  const json = JSON.stringify({ type: 'meta_oauth_error', error: message });
  return `<!DOCTYPE html>
<html lang="uk">
<head><meta charset="utf-8"><title>Facebook OAuth</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;color:#555">
<p>${message}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${json}, '*'); } catch (e) {}
  setTimeout(function() { window.close(); }, 400);
<\/script>
</body>
</html>`;
}

/**
 * Single Meta OAuth redirect for all platform tenants (api-{slug}.direct-ai-agents.com).
 * Meta allowlists one URI: https://admin.{PLATFORM_BASE_DOMAIN}/settings/meta/oauth-callback
 *
 * Verifies signed state → forwards to the tenant API on localhost for token exchange.
 */
export async function metaOAuthHubRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      error_reason?: string;
    };
  }>('/settings/meta/oauth-callback', async (request, reply) => {
    const { code, state, error, error_description, error_reason } = request.query;

    reply.type('text/html');

    if (error) {
      return reply.send(
        buildErrorHtml(error_description ?? error_reason ?? error),
      );
    }

    if (!code || !state) {
      return reply.send(buildErrorHtml('Missing code or state parameter'));
    }

    if (!config.SUPERVISOR_SHARED_SECRET) {
      return reply.send(buildErrorHtml('SUPERVISOR_SHARED_SECRET is not configured on super-admin'));
    }

    const payload = parseHubOAuthState(state, config.SUPERVISOR_SHARED_SECRET);
    if (!payload) {
      return reply.send(buildErrorHtml('Invalid or expired OAuth state — try again'));
    }

    const tenant = await prisma.tenant.findUnique({
      where: { instanceId: payload.i },
    });
    if (!tenant) {
      return reply.send(buildErrorHtml(`Unknown tenant: ${payload.i}`));
    }

    const qs = new URLSearchParams();
    qs.set('code', code);
    qs.set('state', state);
    const target = `http://127.0.0.1:${tenant.apiPort}/settings/meta/oauth-callback?${qs.toString()}`;

    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(120_000) });
      const html = await res.text();
      if (!res.ok) {
        app.log.warn({ status: res.status, instanceId: payload.i }, 'Tenant OAuth callback failed');
        return reply.send(buildErrorHtml(`Tenant OAuth failed (${res.status})`));
      }
      return reply.send(html);
    } catch (err: any) {
      app.log.error({ err, instanceId: payload.i, apiPort: tenant.apiPort }, 'OAuth hub proxy error');
      return reply.send(buildErrorHtml(err?.message ?? 'Tenant API unreachable'));
    }
  });
}
