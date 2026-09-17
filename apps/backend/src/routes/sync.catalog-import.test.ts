import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  startCatalogImport,
  confirmCatalogImport,
  getCatalogImportSettings,
  loadManualCatalogFiles,
  setCatalogSourcePriority,
  clearManualCatalog,
  loadCatalogImportSession,
  isCrmCatalogAvailable,
  resolveEffectiveCatalogSource,
} = vi.hoisted(() => ({
  startCatalogImport: vi.fn(),
  confirmCatalogImport: vi.fn(),
  getCatalogImportSettings: vi.fn(),
  loadManualCatalogFiles: vi.fn(),
  setCatalogSourcePriority: vi.fn(),
  clearManualCatalog: vi.fn(),
  loadCatalogImportSession: vi.fn(),
  isCrmCatalogAvailable: vi.fn(),
  resolveEffectiveCatalogSource: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    crmSyncRun: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../sync-worker.js', () => ({
  runSync: vi.fn(),
  SyncInProgressError: class SyncInProgressError extends Error {},
}));
vi.mock('../lib/synced-services.js', () => ({ loadSyncedServices: vi.fn(async () => []) }));
vi.mock('../services/catalog-import/import-catalog.js', () => ({
  CatalogImportError: class CatalogImportError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'CatalogImportError';
    }
  },
  startCatalogImport,
  confirmCatalogImport,
  getCatalogImportSettings,
  loadManualCatalogFiles,
  setCatalogSourcePriority,
  setCatalogPricePreference: vi.fn(),
  clearManualCatalog,
  loadCatalogImportSession,
}));
vi.mock('../services/catalog-import/catalog-match.js', () => ({
  getCatalogMatchOverview: vi.fn(async () => ({
    matches: [],
    matched: 0,
    unmatchedManual: [],
    unmatchedCrmSample: [],
    crmProductOptions: [],
  })),
  rebuildCatalogMatches: vi.fn(async () => ({ matched: 0, unmatchedManual: 0, matches: [] })),
  removeCatalogMatch: vi.fn(),
  upsertManualCatalogMatch: vi.fn(),
}));
vi.mock('../services/product-search.js', () => ({
  isCrmCatalogAvailable,
  resolveEffectiveCatalogSource,
}));

import { CatalogImportError } from '../services/catalog-import/import-catalog.js';
import { syncRoutes } from './sync.js';

describe('sync catalog-import routes', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    getCatalogImportSettings.mockResolvedValue({
      sourcePriority: 'file',
      lastImportAt: null,
      productCount: 0,
      offerCount: 0,
    });
    isCrmCatalogAvailable.mockResolvedValue(false);
    resolveEffectiveCatalogSource.mockResolvedValue('file');
    loadManualCatalogFiles.mockResolvedValue(null);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildApp() {
    const app = Fastify();
    apps.push(app);
    app.decorate('authenticate', async (request) => {
      (request as { user?: { id: string } }).user = { id: 'owner-1' };
    });
    app.decorate('requireOwner', async () => {});
    await app.register(syncRoutes, { prefix: '/sync' });
    return app;
  }

  it('uploads CSV and returns preview session', async () => {
    startCatalogImport.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      draft: {
        stats: {
          rowCount: 2,
          productCount: 1,
          offerCount: 2,
          categoryCount: 1,
          availableOffers: 2,
          unavailableOffers: 0,
          priceMin: 100,
          priceMax: 200,
          parseWarnings: [],
        },
        products: [
          {
            id: 1,
            name: 'Test',
            minPrice: 100,
            maxPrice: 200,
            quantity: 1,
            isArchived: false,
          },
        ],
      },
      verify: { ok: true, confidence: 0.9, issues: [], summaryUk: 'ok' },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/catalog-import',
      payload: { source: 'shop_express', csv: 'ID;Name;Price\n1;A;10', skipVerify: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(startCatalogImport).toHaveBeenCalled();
  });

  it('rejects confirm when verify failed', async () => {
    confirmCatalogImport.mockRejectedValue(
      new CatalogImportError('Claude verify знайшов критичні проблеми', 400),
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/catalog-import/confirm',
      payload: { sessionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/критичн/i);
  });

  it('lists manual products after import', async () => {
    loadManualCatalogFiles.mockResolvedValue({
      products: [
        {
          id: 1,
          name: 'Худі',
          minPrice: 100,
          maxPrice: 200,
          quantity: 2,
          isArchived: false,
          categoryId: 1,
        },
      ],
      offers: [
        {
          id: 10,
          productId: 1,
          sku: 'a',
          price: 100,
          quantity: 1,
          isArchived: false,
          properties: [{ name: 'Розмір', value: 'L' }],
        },
      ],
      categories: [{ id: 1, name: 'Худі', parentId: null }],
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/sync/catalog-manual/products?q=худі',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(1);
    expect(response.json().products[0].name).toBe('Худі');
  });
});
