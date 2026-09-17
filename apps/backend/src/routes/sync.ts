import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { loadSyncedServices } from '../lib/synced-services.js';
import { runSync, SyncInProgressError } from '../sync-worker.js';
import {
  CatalogImportError,
  clearManualCatalog,
  confirmCatalogImport,
  getCatalogImportSettings,
  loadCatalogImportSession,
  loadManualCatalogFiles,
  setCatalogPricePreference,
  setCatalogSourcePriority,
  startCatalogImport,
} from '../services/catalog-import/import-catalog.js';
import {
  getCatalogMatchOverview,
  rebuildCatalogMatches,
  removeCatalogMatch,
  upsertManualCatalogMatch,
} from '../services/catalog-import/catalog-match.js';
import {
  CATALOG_IMPORT_SOURCES,
  CATALOG_PRICE_PREFERENCES,
  CATALOG_SOURCE_PRIORITIES,
} from '../services/catalog-import/types.js';
import {
  isCrmCatalogAvailable,
  resolveEffectiveCatalogSource,
} from '../services/product-search.js';

function servicesSyncedAt(counts: unknown, finishedAt: Date | null): string | null {
  if (!finishedAt || !counts || typeof counts !== 'object') return null;
  const services = (counts as { services?: unknown }).services;
  if (services == null) return null;
  return finishedAt.toISOString();
}

const importBodySchema = z.object({
  source: z.enum(CATALOG_IMPORT_SOURCES),
  csv: z.string().min(1).max(55_000_000),
  skipVerify: z.boolean().optional(),
});

const confirmBodySchema = z.object({
  sessionId: z.string().uuid(),
  force: z.boolean().optional(),
});

const priorityBodySchema = z
  .object({
    sourcePriority: z.enum(CATALOG_SOURCE_PRIORITIES).optional(),
    pricePreference: z.enum(CATALOG_PRICE_PREFERENCES).optional(),
  })
  .refine((v) => v.sourcePriority != null || v.pricePreference != null, {
    message: 'Потрібен sourcePriority або pricePreference',
  });

const matchLinkBodySchema = z.object({
  manualProductId: z.number().int().positive(),
  crmProductId: z.number().int().positive(),
});

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // POST /sync/trigger — run sync in background (async, don't await)
  app.post('/trigger', { onRequest: [app.authenticate, app.requireOwner] }, async (_request, reply) => {
    const inFlight = await prisma.crmSyncRun.findFirst({
      where: { status: 'running', finishedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (inFlight) {
      return reply.code(409).send({
        error: 'Sync already in progress',
        runId: inFlight.id,
        startedAt: inFlight.startedAt.toISOString(),
      });
    }

    const startedAt = new Date().toISOString();

    runSync()
      .then(() => app.log.info('Sync completed successfully'))
      .catch((err) => {
        if (err instanceof SyncInProgressError) {
          app.log.warn({ runId: err.runId }, 'Skipped — concurrent run in progress');
          return;
        }
        app.log.error({ err }, 'Sync failed');
      });

    return reply.code(202).send({ message: 'Sync triggered', startedAt });
  });

  // GET /sync/status — return last 20 sync runs (newest first)
  app.get('/status', { onRequest: [app.authenticate, app.requireOwner] }, async () => {
    const runs = await prisma.crmSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    return { runs };
  });

  // GET /sync/services — salon services + prices from last sync snapshot
  app.get('/services', { onRequest: [app.authenticate, app.requireOwner] }, async () => {
    const services = await loadSyncedServices();

    const recentOk = await prisma.crmSyncRun.findMany({
      where: { status: 'ok' },
      orderBy: { finishedAt: 'desc' },
      take: 20,
      select: { counts: true, finishedAt: true },
    });
    const syncedAt =
      recentOk.map((run) => servicesSyncedAt(run.counts, run.finishedAt)).find((v) => v != null) ??
      null;

    return {
      services,
      count: services.length,
      syncedAt,
      source: 'snapshot' as const,
    };
  });

  // ── Manual CSV catalog ───────────────────────────────────────────────────

  app.get(
    '/catalog-manual',
    { onRequest: [app.authenticate, app.requireOwner] },
    async () => {
      const [settings, crmAvailable, effectiveSource, files] = await Promise.all([
        getCatalogImportSettings(),
        isCrmCatalogAvailable(),
        resolveEffectiveCatalogSource(),
        loadManualCatalogFiles(),
      ]);
      return {
        settings,
        crmCatalogAvailable: crmAvailable,
        effectiveSource,
        productCount: files?.products.length ?? 0,
        offerCount: files?.offers.length ?? 0,
        categoryCount: files?.categories.length ?? 0,
      };
    },
  );

  app.get<{
    Querystring: { q?: string; page?: string; pageSize?: string };
  }>(
    '/catalog-manual/products',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request) => {
      const files = await loadManualCatalogFiles();
      if (!files) {
        return { products: [], total: 0, page: 1, pageSize: 25 };
      }

      const q = (request.query.q ?? '').trim().toLowerCase();
      const page = Math.max(1, Number(request.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 25));

      const offersByPid = new Map<number, typeof files.offers>();
      for (const o of files.offers) {
        const arr = offersByPid.get(o.productId);
        if (arr) arr.push(o);
        else offersByPid.set(o.productId, [o]);
      }

      let products = files.products;
      if (q) {
        products = products.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            String(p.id).includes(q) ||
            (offersByPid.get(p.id) ?? []).some((o) =>
              (o.sku ?? '').toLowerCase().includes(q),
            ),
        );
      }

      const total = products.length;
      const slice = products.slice((page - 1) * pageSize, page * pageSize).map((p) => {
        const offers = offersByPid.get(p.id) ?? [];
        return {
          id: p.id,
          name: p.name,
          minPrice: p.minPrice,
          maxPrice: p.maxPrice,
          quantity: p.quantity,
          isArchived: p.isArchived,
          categoryId: p.categoryId,
          offerCount: offers.length,
          offers: offers.slice(0, 30).map((o) => ({
            id: o.id,
            sku: o.sku,
            price: o.price,
            quantity: o.quantity,
            isArchived: o.isArchived,
            properties: o.properties,
          })),
        };
      });

      return { products: slice, total, page, pageSize };
    },
  );

  app.post(
    '/catalog-import',
    {
      onRequest: [app.authenticate, app.requireOwner],
      bodyLimit: 55 * 1024 * 1024,
    },
    async (request, reply) => {
      const parsed = importBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Некоректний запит імпорту',
          details: z.flattenError(parsed.error).fieldErrors,
        });
      }

      try {
        const session = await startCatalogImport({
          source: parsed.data.source,
          csvText: parsed.data.csv,
          skipVerify: parsed.data.skipVerify === true,
        });
        app.log.info(
          {
            sessionId: session.id,
            source: parsed.data.source,
            products: session.draft.stats.productCount,
            ownerUserId: request.user?.id,
          },
          'Catalog CSV import draft created',
        );
        return {
          sessionId: session.id,
          expiresAt: session.expiresAt,
          stats: session.draft.stats,
          verify: session.verify,
          sampleProducts: session.draft.products.slice(0, 20).map((p) => ({
            id: p.id,
            name: p.name,
            minPrice: p.minPrice,
            maxPrice: p.maxPrice,
            quantity: p.quantity,
            isArchived: p.isArchived,
          })),
        };
      } catch (err) {
        if (err instanceof CatalogImportError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        if (err instanceof Error) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    '/catalog-import/:sessionId',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const session = await loadCatalogImportSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Сесія імпорту не знайдена або протермінована' });
      }
      return {
        sessionId: session.id,
        expiresAt: session.expiresAt,
        stats: session.draft.stats,
        verify: session.verify,
        sampleProducts: session.draft.products.slice(0, 40).map((p) => ({
          id: p.id,
          name: p.name,
          minPrice: p.minPrice,
          maxPrice: p.maxPrice,
          quantity: p.quantity,
          isArchived: p.isArchived,
        })),
      };
    },
  );

  app.post(
    '/catalog-import/confirm',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const parsed = confirmBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Некоректний sessionId' });
      }
      try {
        const result = await confirmCatalogImport(parsed.data.sessionId, {
          force: parsed.data.force === true,
        });
        app.log.info(
          { sessionId: parsed.data.sessionId, ownerUserId: request.user?.id, ...result },
          'Catalog CSV import confirmed',
        );
        return { ok: true, ...result };
      } catch (err) {
        if (err instanceof CatalogImportError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.patch(
    '/catalog-manual/priority',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const parsed = priorityBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Потрібен sourcePriority і/або pricePreference (file|crm)',
        });
      }

      let settings = await getCatalogImportSettings();
      if (parsed.data.sourcePriority) {
        if (parsed.data.sourcePriority === 'crm') {
          const crmOk = await isCrmCatalogAvailable();
          if (!crmOk) {
            return reply.code(400).send({
              error: 'CRM каталог недоступний — пріоритет пошуку лишається на файлі',
            });
          }
        }
        settings = await setCatalogSourcePriority(parsed.data.sourcePriority);
      }
      if (parsed.data.pricePreference) {
        if (parsed.data.pricePreference === 'crm') {
          const crmOk = await isCrmCatalogAvailable();
          if (!crmOk) {
            return reply.code(400).send({
              error: 'CRM каталог недоступний — ціна лишається з файлу',
            });
          }
        }
        settings = await setCatalogPricePreference(parsed.data.pricePreference);
      }
      const effectiveSource = await resolveEffectiveCatalogSource();
      return { settings, effectiveSource };
    },
  );

  app.get(
    '/catalog-matches',
    { onRequest: [app.authenticate, app.requireOwner] },
    async () => getCatalogMatchOverview(),
  );

  app.post(
    '/catalog-matches/rebuild',
    { onRequest: [app.authenticate, app.requireOwner] },
    async () => {
      const result = await rebuildCatalogMatches();
      return {
        ok: true,
        matched: result.matched,
        unmatchedManual: result.unmatchedManual,
      };
    },
  );

  app.put(
    '/catalog-matches',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const parsed = matchLinkBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Потрібні manualProductId і crmProductId' });
      }
      const matches = await upsertManualCatalogMatch(
        parsed.data.manualProductId,
        parsed.data.crmProductId,
      );
      return { ok: true, matches };
    },
  );

  app.delete<{ Params: { manualProductId: string } }>(
    '/catalog-matches/:manualProductId',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const id = Number(request.params.manualProductId);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: 'Некоректний manualProductId' });
      }
      const matches = await removeCatalogMatch(id);
      return { ok: true, matches };
    },
  );

  app.delete(
    '/catalog-manual',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request) => {
      await clearManualCatalog();
      app.log.info({ ownerUserId: request.user?.id }, 'Manual catalog cleared');
      return { ok: true };
    },
  );
}
