import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  verifyCatalogImportDraft,
  paths,
  rebuildCatalogMatches,
} = vi.hoisted(() => {
  const paths = {
    products: '',
    offers: '',
    categories: '',
    catalogTxt: '',
    matches: '',
    repoRoot: '',
  };
  return {
    prismaMock: {
      setting: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
    },
    verifyCatalogImportDraft: vi.fn(),
    rebuildCatalogMatches: vi.fn(async () => ({ matched: 0, unmatchedManual: 0, matches: [] })),
    paths,
  };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: prismaMock,
  toInputJsonValue: (v: unknown) => v,
}));
vi.mock('../../lib/catalog-index.js', () => ({
  invalidateCatalogIndexCache: vi.fn(),
}));
vi.mock('./verify-catalog.js', () => ({ verifyCatalogImportDraft }));
vi.mock('./catalog-match.js', () => ({ rebuildCatalogMatches }));
vi.mock('../../lib/paths.js', () => ({
  REPO_ROOT: paths.repoRoot,
  getManualProductsPath: () => paths.products,
  getManualOffersPath: () => paths.offers,
  getManualCategoriesPath: () => paths.categories,
  getManualCatalogPath: () => paths.catalogTxt,
  getCatalogMatchesPath: () => paths.matches,
}));

import {
  CatalogImportError,
  clearManualCatalog,
  confirmCatalogImport,
  getCatalogImportSettings,
  loadManualCatalogFiles,
  startCatalogImport,
} from './import-catalog.js';

const MINI_CSV = [
  '"ID";"Name";"Price";"ActionPrice";"Sku";"Currency";"Categories";"ProductModificationName";"InStock";"IsAvailable"',
  '"101";"Худі таш";"2189,0000";"0,0000";"sku-l";"UAH";"Худі";"Чорний, L";"0";"Available"',
  '"102";"Худі таш";"2189,0000";"0,0000";"sku-xl";"UAH";"Худі";"Чорний, XL";"0";"Available"',
].join('\n');

describe('import-catalog service', () => {
  let tmp: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), 'catalog-import-'));
    paths.repoRoot = tmp;
    paths.products = join(tmp, 'manual-products.json');
    paths.offers = join(tmp, 'manual-offers.json');
    paths.categories = join(tmp, 'manual-categories.json');
    paths.catalogTxt = join(tmp, 'catalog-manual.txt');
    paths.matches = join(tmp, 'catalog-matches.json');

    prismaMock.setting.findUnique.mockResolvedValue(null);
    prismaMock.setting.upsert.mockImplementation(async ({ create, update }: {
      create: { value: unknown };
      update: { value: unknown };
    }) => ({ value: update?.value ?? create.value }));

    verifyCatalogImportDraft.mockResolvedValue({
      ok: true,
      confidence: 0.9,
      issues: [],
      summaryUk: 'ok',
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('starts draft with skipVerify and parses Shop-Express CSV', async () => {
    const session = await startCatalogImport({
      source: 'shop_express',
      csvText: MINI_CSV,
      skipVerify: true,
    });

    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(session.draft.stats.productCount).toBe(1);
    expect(session.draft.stats.offerCount).toBe(2);
    expect(session.draft.products[0]?.name).toContain('Худі');
    expect(session.draft.products[0]?.minPrice).toBe(2189);
    expect(session.verify.ok).toBe(true);
    expect(verifyCatalogImportDraft).not.toHaveBeenCalled();
  });

  it('runs Claude verify when skipVerify is false', async () => {
    verifyCatalogImportDraft.mockResolvedValue({
      ok: true,
      confidence: 0.8,
      issues: [{ severity: 'warning', message: 'мало sample' }],
      summaryUk: 'warnings',
    });

    const session = await startCatalogImport({
      source: 'shop_express',
      csvText: MINI_CSV,
    });

    expect(verifyCatalogImportDraft).toHaveBeenCalledOnce();
    expect(session.verify.issues).toHaveLength(1);
  });

  it('blocks confirm when verify failed unless force', async () => {
    verifyCatalogImportDraft.mockResolvedValue({
      ok: false,
      confidence: 0.2,
      issues: [{ severity: 'critical', message: 'усі ціни 0' }],
      summaryUk: 'bad',
    });

    const session = await startCatalogImport({
      source: 'shop_express',
      csvText: MINI_CSV,
    });

    await expect(confirmCatalogImport(session.id)).rejects.toMatchObject({
      name: 'CatalogImportError',
      statusCode: 400,
    } satisfies Partial<CatalogImportError>);

    const forced = await confirmCatalogImport(session.id, { force: true });
    expect(forced.productCount).toBe(1);
    expect(forced.offerCount).toBe(2);

    const productsRaw = await readFile(paths.products, 'utf8');
    const products = JSON.parse(productsRaw) as Array<{ name: string }>;
    expect(products[0]?.name).toContain('Худі');

    const catalogTxt = await readFile(paths.catalogTxt, 'utf8');
    expect(catalogTxt).toContain('Худі таш');
    expect(catalogTxt).toContain('2189');
  });

  it('confirms ok verify and writes manual files', async () => {
    const session = await startCatalogImport({
      source: 'shop_express',
      csvText: MINI_CSV,
      skipVerify: true,
    });

    const result = await confirmCatalogImport(session.id);
    expect(result.productCount).toBe(1);
    expect(prismaMock.setting.upsert).toHaveBeenCalled();

    const loaded = await loadManualCatalogFiles();
    expect(loaded?.products).toHaveLength(1);
    expect(loaded?.offers).toHaveLength(2);
    expect(loaded?.categories.some((c) => c.name === 'Худі')).toBe(true);
  });

  it('rejects missing session on confirm', async () => {
    await expect(
      confirmCatalogImport('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('clears manual catalog files and resets settings', async () => {
    const session = await startCatalogImport({
      source: 'shop_express',
      csvText: MINI_CSV,
      skipVerify: true,
    });
    await confirmCatalogImport(session.id);
    expect(await loadManualCatalogFiles()).not.toBeNull();

    await clearManualCatalog();
    expect(await loadManualCatalogFiles()).toBeNull();
    expect(prismaMock.setting.upsert).toHaveBeenCalled();
  });

  it('returns default settings when DB empty', async () => {
    const settings = await getCatalogImportSettings();
    expect(settings.sourcePriority).toBe('file');
    expect(settings.verifyStatus).toBe('none');
  });
});
