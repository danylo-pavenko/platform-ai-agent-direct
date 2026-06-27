import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  invalidateIntegrationConfigCache,
  SENSITIVE_FIELDS,
  META_ENV_ONLY_FIELDS,
} from '../lib/integration-config.js';
import { invalidateAgentConfigCache } from '../lib/agent-config.js';
import { invalidateRuntimeConfigCache } from '../lib/runtime-config.js';
import { resolveCityRef } from '../services/nova-poshta.js';
import { runTenantHealthCheck } from '../services/health-check.js';
import { loadClaudeUsageSnapshot, runClaudeUsageCheck } from '../services/claude-usage-monitor.js';
import { subscribePageToMetaWebhooks } from '../lib/meta-page-subscribe.js';
import { getIntegrationConfig } from '../lib/integration-config.js';
import { syncWebhookRoutingToHub } from '../lib/webhook-hub-sync.js';
import { invalidateCrmWriteCache } from '../lib/crm-write.js';
import { invalidateFeatureFlagsCache } from '../lib/feature-flags.js';
import { isMaskedIntegrationSecret } from '../lib/integration-secrets.js';
import { normalizeKeycrmAppUrl } from '../lib/keycrm-urls.js';
import { sendTelegramTestMessage } from '../services/telegram-test.js';
import { runMetaAgentTest } from '../services/meta-agent-test.js';
import {
  cancelClaudeAuthLogin,
  getClaudeAuthStatus,
  getClaudeLoginStatus,
  startClaudeAuthLogin,
  submitClaudeAuthCode,
} from '../services/claude-auth.js';

const INTEGRATION_KEYS = ['integration_meta', 'integration_telegram', 'integration_keycrm', 'integration_novaposhta'];

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET / - Get all non-integration settings
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const settings = await prisma.setting.findMany({
      where: { key: { notIn: INTEGRATION_KEYS } },
    });

    const result: Record<string, unknown> = {};
    for (const setting of settings) {
      result[setting.key] = setting.value;
    }

    return result;
  });

  // PUT / - Update settings (non-integration)
  app.put<{
    Body: Record<string, unknown>;
  }>('/', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Body must be a JSON object' });
    }

    // Reject integration keys from this endpoint
    const filtered = Object.fromEntries(
      Object.entries(body).filter(([key]) => !INTEGRATION_KEYS.includes(key)),
    );

    if (Object.keys(filtered).length === 0) {
      return reply.code(400).send({ error: 'No settings provided' });
    }

    await Promise.all(
      Object.entries(filtered).map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          create: { key, value: value as any },
          update: { value: value as any },
        }),
      ),
    );

    if ('agent_config' in filtered) {
      invalidateAgentConfigCache();
    }
    if ('runtime_mode' in filtered) {
      invalidateRuntimeConfigCache();
    }
    if ('feature_flags' in filtered) {
      invalidateCrmWriteCache();
      invalidateFeatureFlagsCache();
    }

    const settings = await prisma.setting.findMany({
      where: { key: { notIn: INTEGRATION_KEYS } },
    });
    const result: Record<string, unknown> = {};
    for (const setting of settings) {
      result[setting.key] = setting.value;
    }

    return result;
  });

  // ── Integration settings ─────────────────────────────────────────────────

  /**
   * GET /settings/integrations
   * Returns integration config with sensitive fields masked as "••••••"
   * so the UI can show whether a secret is configured without leaking it.
   */
  app.get('/integrations', { onRequest: [app.authenticate] }, async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: INTEGRATION_KEYS } },
    });

    const result: Record<string, Record<string, unknown>> = {
      integration_meta: {},
      integration_telegram: {},
      integration_keycrm: {},
      integration_novaposhta: {},
    };

    for (const row of rows) {
      const data = row.value as Record<string, unknown>;
      const masked: Record<string, unknown> = { ...data };
      const sensitive = SENSITIVE_FIELDS[row.key] ?? [];
      const envOnly = row.key === 'integration_meta' ? META_ENV_ONLY_FIELDS : [];

      for (const field of envOnly) delete masked[field];
      for (const field of sensitive) {
        if (masked[field]) masked[field] = '••••••';
      }

      result[row.key] = masked;
    }

    return result;
  });

  /**
   * PUT /settings/integrations
   * Accepts { integration_meta?, integration_telegram?, integration_keycrm? }.
   * Fields with value "••••••" are preserved (not overwritten).
   */
  app.put<{
    Body: Record<string, Record<string, unknown>>;
  }>('/integrations', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Body must be a JSON object' });
    }

    for (const key of INTEGRATION_KEYS) {
      if (!(key in body)) continue;

      const incoming = body[key];
      if (!incoming || typeof incoming !== 'object') continue;

      // Load existing value to preserve masked secrets
      const existing = await prisma.setting.findUnique({ where: { key } });
      const existingData = (existing?.value ?? {}) as Record<string, unknown>;

      const merged: Record<string, unknown> = { ...existingData };
      const sensitive = SENSITIVE_FIELDS[key] ?? [];
      const envOnly = key === 'integration_meta' ? META_ENV_ONLY_FIELDS : [];

      for (const [field, value] of Object.entries(incoming)) {
        // Never store env-only fields in DB
        if (envOnly.includes(field)) continue;
        // Skip masked placeholder — keep existing value (•••••• or •••••• (збережено…))
        if (sensitive.includes(field) && isMaskedIntegrationSecret(value)) continue;
        merged[field] = value;
      }

      // Clean up any previously stored env-only fields
      for (const f of envOnly) delete merged[f];

      if (key === 'integration_keycrm' && 'defaultSourceId' in merged) {
        const raw = merged.defaultSourceId;
        if (raw === '' || raw === null || raw === undefined) {
          delete merged.defaultSourceId;
        } else {
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(n) || n < 1) {
            return reply.code(400).send({
              error: 'KeyCRM defaultSourceId must be a positive integer',
            });
          }
          merged.defaultSourceId = Math.floor(n);
        }
      }

      if (key === 'integration_keycrm' && 'appUrl' in merged) {
        const raw = merged.appUrl;
        if (raw === '' || raw === null || raw === undefined) {
          merged.appUrl = '';
        } else if (typeof raw === 'string') {
          const normalized = normalizeKeycrmAppUrl(raw);
          if (!normalized) {
            return reply.code(400).send({
              error: 'KeyCRM app URL is invalid — use e.g. https://blessed.keycrm.app',
            });
          }
          merged.appUrl = normalized;
        }
      }

      await prisma.setting.upsert({
        where: { key },
        create: { key, value: merged as any },
        update: { value: merged as any },
      });

      if (key === 'integration_meta') {
        const pageId = merged.pageId;
        const pageAccessToken = merged.pageAccessToken;
        const igUserId = merged.igUserId;
        if (
          typeof pageId === 'string' &&
          pageId &&
          typeof pageAccessToken === 'string' &&
          pageAccessToken &&
          !isMaskedIntegrationSecret(pageAccessToken)
        ) {
          subscribePageToMetaWebhooks(pageId, pageAccessToken)
            .then((sub) => {
              if (!sub.ok) {
                app.log.warn(
                  { status: sub.status, body: sub.body, pageId },
                  'Manual meta save: webhook subscription failed (non-fatal)',
                );
              } else {
                app.log.info({ pageId }, 'Manual meta save: Page webhook subscribed');
              }
            })
            .catch((err) => {
              app.log.warn({ err, pageId }, 'Manual meta save: webhook subscription error');
            });
        }
        if (typeof igUserId === 'string' && igUserId) {
          const { meta } = await getIntegrationConfig();
          const token =
            typeof pageAccessToken === 'string' && !isMaskedIntegrationSecret(pageAccessToken)
              ? pageAccessToken
              : meta.pageAccessToken;
          if (meta.facebookAppSecret) {
            const pid =
              typeof pageId === 'string' && pageId ? pageId : meta.pageId;
            syncWebhookRoutingToHub(igUserId, meta.facebookAppSecret, app.log, token, pid);
          }
        }
      }
    }

    // Bust the cache so next request picks up new values
    invalidateIntegrationConfigCache();

    return { ok: true };
  });

  /** POST /settings/health-check
   * Self-diagnostic for the tenant instance: Instagram, Claude, CRM, agent latency.
   */
  app.post('/health-check', { onRequest: [app.authenticate] }, async () => {
    return runTenantHealthCheck();
  });

  /** GET /settings/claude-auth — Claude CLI binary + session status. */
  app.get<{ Querystring: { fresh?: string } }>(
    '/claude-auth',
    { onRequest: [app.authenticate] },
    async (request) => {
      return getClaudeAuthStatus({ skipLiveCache: request.query.fresh === 'true' });
    },
  );

  /** POST /settings/claude-auth/login/start — spawn claude auth login, return OAuth URL. */
  app.post('/claude-auth/login/start', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const current = await getClaudeAuthStatus();
    if (current.loggedIn) {
      return reply.code(409).send({ error: 'Claude вже авторизовано на цьому інстансі' });
    }
    if (!current.binaryOk) {
      return reply.code(503).send({ error: current.error ?? 'Claude CLI недоступний' });
    }
    if (current.loginInProgress) {
      return reply.code(409).send({ error: 'Авторизація вже запущена — зачекайте або скасуйте' });
    }

    const result = await startClaudeAuthLogin();
    if (result.status === 'failed' && !result.sessionId) {
      return reply.code(429).send({ error: result.error ?? 'Не вдалося запустити вхід' });
    }
    return result;
  });

  /** GET /settings/claude-auth/login/status?sessionId= — poll OAuth completion. */
  app.get<{ Querystring: { sessionId?: string } }>(
    '/claude-auth/login/status',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const sessionId = request.query.sessionId?.trim();
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }
      const status = await getClaudeLoginStatus(sessionId);
      if (!status) {
        return reply.code(404).send({ error: 'Session not found or expired' });
      }
      return status;
    },
  );

  /** POST /settings/claude-auth/login/code — pipe OAuth callback code into CLI stdin. */
  app.post<{ Body: { sessionId?: string; code?: string } }>(
    '/claude-auth/login/code',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const sessionId = request.body?.sessionId?.trim();
      const code = request.body?.code?.trim();
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }
      if (!code) {
        return reply.code(400).send({ error: 'code is required' });
      }
      const result = submitClaudeAuthCode(sessionId, code);
      if (!result.ok) {
        return reply.code(400).send({ error: result.error ?? 'Не вдалося надіслати код' });
      }
      return { ok: true };
    },
  );

  /** POST /settings/claude-auth/login/cancel — abort in-progress login. */
  app.post<{ Body: { sessionId?: string } }>(
    '/claude-auth/login/cancel',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const sessionId = request.body?.sessionId?.trim();
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }
      if (!cancelClaudeAuthLogin(sessionId)) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return { ok: true };
    },
  );

  /** GET /settings/claude-usage — latest subscription usage snapshot (auto-polled). */
  app.get('/claude-usage', { onRequest: [app.authenticate] }, async () => {
    const snapshot = await loadClaudeUsageSnapshot();
    return {
      snapshot,
      checkIntervalMin: config.CLAUDE_USAGE_CHECK_INTERVAL_MIN,
      warningPercent: config.CLAUDE_USAGE_WARNING_PERCENT,
    };
  });

  /** POST /settings/claude-usage/check — on-demand refresh. */
  app.post('/claude-usage/check', { onRequest: [app.authenticate] }, async () => {
    const snapshot = await runClaudeUsageCheck();
    return {
      snapshot,
      checkIntervalMin: config.CLAUDE_USAGE_CHECK_INTERVAL_MIN,
      warningPercent: config.CLAUDE_USAGE_WARNING_PERCENT,
    };
  });

  /**
   * POST /settings/telegram/test
   * Send a test message to manager notification group(s).
   * Body may include unsaved botToken / managerGroupId for pre-save testing.
   */
  app.post<{
    Body: {
      variant?: 'connectivity' | 'meta_agent';
      botToken?: string;
      managerGroupId?: string;
    };
  }>('/telegram/test', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { variant, botToken, managerGroupId } = request.body ?? {};
    try {
      const result = await sendTelegramTestMessage({ variant, botToken, managerGroupId });
      if (!result.ok) {
        return reply.code(400).send(result);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /** POST /settings/meta-agent/test — ping Claude on the meta_agent channel. */
  app.post('/meta-agent/test', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const result = await runMetaAgentTest();
    if (!result.ok) {
      return reply.code(503).send(result);
    }
    return result;
  });

  const PURGE_DIALOGS_CONFIRM = 'ВИДАЛИТИ ДІАЛОГИ';

  /**
   * POST /settings/purge-dialogs
   * Irreversible wipe of all clients, conversations, messages, orders and briefs.
   * Requires exact confirmation phrase in body.confirm.
   */
  app.post<{ Body: { confirm?: string } }>(
    '/purge-dialogs',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      if (request.body?.confirm !== PURGE_DIALOGS_CONFIRM) {
        return reply.code(400).send({
          error: `Для підтвердження надішліть confirm: "${PURGE_DIALOGS_CONFIRM}"`,
        });
      }

      const [clients, conversations, messages, orders, briefs] = await Promise.all([
        prisma.client.count(),
        prisma.conversation.count(),
        prisma.message.count(),
        prisma.order.count(),
        prisma.presaleBrief.count(),
      ]);

      if (clients === 0 && conversations === 0) {
        return { ok: true, deleted: { clients: 0, conversations: 0, messages: 0, orders: 0, briefs: 0 } };
      }

      await prisma.client.deleteMany({});

      app.log.warn(
        { clients, conversations, messages, orders, briefs },
        'All dialog data purged via admin settings',
      );

      return {
        ok: true,
        deleted: { clients, conversations, messages, orders, briefs },
      };
    },
  );

  // POST /settings/nova-poshta/resolve-city
  // Given a city name, returns its NP Ref UUID. Used to configure sender city.
  app.post<{ Body: { cityName: string } }>(
    '/nova-poshta/resolve-city',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { cityName } = request.body ?? {};
      if (!cityName || typeof cityName !== 'string') {
        return reply.code(400).send({ error: 'cityName is required' });
      }

      const result = await resolveCityRef(cityName.trim());
      if (!result) {
        return reply.code(404).send({ error: `City "${cityName}" not found in Nova Poshta` });
      }

      return result;
    },
  );
}
