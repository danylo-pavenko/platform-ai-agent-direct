/**
 * Super Admin analytics — cache-first fleet + live refresh.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPlatformVersion } from '../lib/platform-version.js';
import {
  parseAnalyticsPeriod,
  readFleetFromCache,
  refreshFleetAnalytics,
  readOneTenantFromCache,
  refreshOneTenantAnalytics,
} from '../lib/analytics-cache.js';

const PeriodSchema = z.enum(['7d', '30d', '90d']).default('7d');

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [app.authenticate] };

  /** Instant: DB cache only (no tenant HTTP). */
  app.get<{ Querystring: { period?: string } }>(
    '/api/analytics/fleet',
    auth,
    async (req) => {
      const parsed = PeriodSchema.safeParse(req.query.period ?? '7d');
      const period = parsed.success ? parsed.data : parseAnalyticsPeriod(req.query.period);
      const cached = await readFleetFromCache(period);
      return cached;
    },
  );

  /** Live fan-out + persist. Use after painting cache. */
  app.post<{ Querystring: { period?: string } }>(
    '/api/analytics/fleet/refresh',
    auth,
    async (req) => {
      const parsed = PeriodSchema.safeParse(req.query.period ?? '7d');
      const period = parsed.success ? parsed.data : parseAnalyticsPeriod(req.query.period);
      return refreshFleetAnalytics(period);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/api/analytics/tenants/:id',
    auth,
    async (req, reply) => {
      const parsed = PeriodSchema.safeParse(req.query.period ?? '7d');
      const period = parsed.success ? parsed.data : parseAnalyticsPeriod(req.query.period);
      const saVersion = getPlatformVersion();
      const cached = await readOneTenantFromCache(req.params.id, period);
      if (cached) {
        return {
          generatedAt: new Date().toISOString(),
          saVersion: { name: saVersion.name, code: saVersion.code },
          tenant: cached,
          source: 'cache' as const,
        };
      }
      const live = await refreshOneTenantAnalytics(req.params.id, period);
      if (!live) return reply.status(404).send({ error: 'Not found' });
      return {
        generatedAt: new Date().toISOString(),
        saVersion: { name: saVersion.name, code: saVersion.code },
        tenant: live,
        source: 'live' as const,
      };
    },
  );

  app.post<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/api/analytics/tenants/:id/refresh',
    auth,
    async (req, reply) => {
      const parsed = PeriodSchema.safeParse(req.query.period ?? '7d');
      const period = parsed.success ? parsed.data : parseAnalyticsPeriod(req.query.period);
      const saVersion = getPlatformVersion();
      const live = await refreshOneTenantAnalytics(req.params.id, period);
      if (!live) return reply.status(404).send({ error: 'Not found' });
      return {
        generatedAt: new Date().toISOString(),
        saVersion: { name: saVersion.name, code: saVersion.code },
        tenant: live,
        source: 'live' as const,
      };
    },
  );
}
