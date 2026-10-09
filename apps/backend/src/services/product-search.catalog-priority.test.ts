import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getCatalogImportSettings,
  loadManualCatalogIndex,
  loadCatalogIndex,
  loadCatalogMatches,
  getIntegrationConfig,
} = vi.hoisted(() => ({
  getCatalogImportSettings: vi.fn(),
  loadManualCatalogIndex: vi.fn(),
  loadCatalogIndex: vi.fn(),
  loadCatalogMatches: vi.fn(),
  getIntegrationConfig: vi.fn(),
}));

vi.mock('./catalog-import/import-catalog.js', () => ({ getCatalogImportSettings }));
vi.mock('./catalog-import/catalog-match.js', () => ({ loadCatalogMatches }));
vi.mock('../lib/catalog-index.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/catalog-index.js')>(
    '../lib/catalog-index.js',
  );
  return {
    ...actual,
    loadManualCatalogIndex,
    loadCatalogIndex,
  };
});
vi.mock('../lib/integration-config.js', () => ({ getIntegrationConfig }));
vi.mock('../lib/crm-routing.js', () => ({
  resolveCrmProvider: vi.fn(async () => 'keycrm'),
}));
vi.mock('./crm/index.js', () => ({
  getCrmAdapter: vi.fn(() => ({
    name: 'keycrm',
    searchProducts: vi.fn(async () => []),
    searchOffers: vi.fn(async () => []),
  })),
}));

import {
  resolveEffectiveCatalogSource,
  searchActiveProductsForContext,
} from './product-search.js';

describe('product-search catalog match + price preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationConfig.mockResolvedValue({ keycrm: { apiKey: 'k' } });
    loadCatalogMatches.mockResolvedValue([
      {
        manualProductId: 1,
        crmProductId: 50,
        method: 'sku',
        confidence: 'high',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    loadManualCatalogIndex.mockResolvedValue({
      mtimeMs: 1,
      source: 'manual',
      products: [
        {
          id: 1,
          name: 'Худі таш',
          isArchived: false,
          minPrice: 2189,
          maxPrice: 2189,
          quantity: 2,
        },
      ],
      offersByProductId: new Map([
        [
          1,
          [
            {
              id: 10,
              productId: 1,
              price: 2189,
              quantity: 2,
              inReserve: 0,
              isArchived: false,
              properties: [{ name: 'Розмір', value: 'L' }],
              sku: 'x',
              barcode: null,
              thumbnailUrl: null,
              purchasedPrice: 0,
            },
          ],
        ],
      ]),
    });
    loadCatalogIndex.mockResolvedValue({
      mtimeMs: 1,
      source: 'crm',
      products: [
        {
          id: 50,
          name: 'Худі таш CRM',
          isArchived: false,
          minPrice: 2290,
          maxPrice: 2290,
          quantity: 1,
        },
      ],
      offersByProductId: new Map([
        [
          50,
          [
            {
              id: 60,
              productId: 50,
              price: 2290,
              quantity: 1,
              inReserve: 0,
              isArchived: false,
              properties: [{ name: 'Розмір', value: 'L' }],
              sku: 'x',
              barcode: null,
              thumbnailUrl: null,
              purchasedPrice: 0,
            },
          ],
        ],
      ]),
    });
  });

  it('forces file when CRM catalog unavailable', async () => {
    getIntegrationConfig.mockResolvedValue({ keycrm: { apiKey: '' } });
    loadCatalogIndex.mockResolvedValue(null);
    getCatalogImportSettings.mockResolvedValue({
      sourcePriority: 'crm',
      pricePreference: 'crm',
    });
    expect(await resolveEffectiveCatalogSource()).toBe('file');
  });

  it('quotes file price and notes CRM alt when preference is file', async () => {
    getCatalogImportSettings.mockResolvedValue({
      sourcePriority: 'file',
      pricePreference: 'file',
    });
    const result = await searchActiveProductsForContext('худі');
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.contextBlock).toContain('2189');
    expect(result.contextBlock).toContain('ціна з файлу');
    expect(result.contextBlock).toContain('доступно до замовлення');
    expect(result.contextBlock).not.toMatch(/\d+ шт/);
    expect(result.contextBlock).toMatch(/CRM:.*2290/);
  });

  it('offers every available color of a Blessed hoodie, including split products', async () => {
    const offer = (id: number, productId: number, color: string, archived = false) => ({
      id,
      productId,
      price: 2190,
      quantity: 1,
      inReserve: 0,
      isArchived: archived,
      properties: [{ name: 'Колір', value: color }],
      sku: null,
      barcode: null,
      thumbnailUrl: null,
      purchasedPrice: 0,
    });
    const item = (id: number, name: string) => ({
      id,
      name,
      isArchived: false,
      minPrice: 2190,
      maxPrice: 2190,
      quantity: 1,
    });
    loadCatalogMatches.mockResolvedValue([]);
    loadCatalogIndex.mockResolvedValue(null);
    loadManualCatalogIndex.mockResolvedValue({
      mtimeMs: 1,
      source: 'manual',
      products: [
        item(1, 'Худі (вишня) Blessed'),
        item(2, 'Худі чорний "Благословенний"'),
        item(3, 'Худі рожевий "Благословенний"'),
        item(4, 'Футболка "Благословенний"'),
      ],
      offersByProductId: new Map([
        [1, [offer(11, 1, 'Багряний'), offer(12, 1, 'Білий', true)]],
        [2, [offer(21, 2, 'Чорний')]],
        [3, [offer(31, 3, 'рожевий')]],
        [4, [offer(41, 4, 'Білий')]],
      ]),
    });
    getCatalogImportSettings.mockResolvedValue({
      sourcePriority: 'file',
      pricePreference: 'file',
    });

    const result = await searchActiveProductsForContext('худі blessed');
    expect(result.contextBlock).toContain(
      'Кольори худі «благословенний», які можна пропонувати: Багряний, Чорний, рожевий',
    );
    expect(result.contextBlock).not.toContain('Футболка');
    expect(result.contextBlock).not.toMatch(/Кольори худі.*Білий/);
  });

  it('quotes CRM price when pricePreference is crm', async () => {
    getCatalogImportSettings.mockResolvedValue({
      sourcePriority: 'file',
      pricePreference: 'crm',
    });
    const result = await searchActiveProductsForContext('худі');
    expect(result.contextBlock).toContain('2290');
    expect(result.contextBlock).toContain('ціна з CRM');
  });
});
