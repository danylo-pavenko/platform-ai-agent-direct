import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import {
  invalidateIntegrationConfigCache,
  SENSITIVE_FIELDS,
} from '../lib/integration-config.js';

const INTEGRATION_KEYS = ['integration_meta', 'integration_telegram', 'integration_keycrm'];

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET / — Get all non-integration settings
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

  // PUT / — Update settings (non-integration)
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
    };

    for (const row of rows) {
      const data = row.value as Record<string, unknown>;
      const masked: Record<string, unknown> = { ...data };
      const sensitive = SENSITIVE_FIELDS[row.key] ?? [];

      for (const field of sensitive) {
        if (masked[field]) {
          masked[field] = '••••••';
        }
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

      for (const [field, value] of Object.entries(incoming)) {
        // Skip masked placeholder — keep existing value
        if (sensitive.includes(field) && value === '••••••') {
          continue;
        }
        merged[field] = value;
      }

      await prisma.setting.upsert({
        where: { key },
        create: { key, value: merged as any },
        update: { value: merged as any },
      });
    }

    // Bust the cache so next request picks up new values
    invalidateIntegrationConfigCache();

    return { ok: true };
  });
}
