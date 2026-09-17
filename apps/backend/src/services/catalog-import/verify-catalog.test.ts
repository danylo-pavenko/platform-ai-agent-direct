import { describe, expect, it, vi, beforeEach } from 'vitest';

const { askClaude } = vi.hoisted(() => ({ askClaude: vi.fn() }));

vi.mock('../claude.js', () => ({ askClaude }));

import { verifyCatalogImportDraft } from './verify-catalog.js';
import type { CatalogImportDraft } from './types.js';

const draft: CatalogImportDraft = {
  source: 'shop_express',
  products: [],
  offers: [],
  categories: [],
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
  sampleRows: [
    {
      rawName: 'A',
      rawPrice: '100,0000',
      rawSku: 's1',
      rawModification: 'L',
      rawAvailable: 'Available',
      mappedProductId: 1,
      mappedOfferId: 10,
      mappedPrice: 100,
      mappedQty: 1,
      mappedArchived: false,
    },
  ],
};

describe('verifyCatalogImportDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses Claude JSON ok result', async () => {
    askClaude.mockResolvedValue({
      text: '```json\n{"ok":true,"confidence":0.95,"issues":[],"summaryUk":"Все ок"}\n```',
    });

    const result = await verifyCatalogImportDraft(draft);
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.summaryUk).toBe('Все ок');
  });

  it('treats critical issues as not ok even if ok:true', async () => {
    askClaude.mockResolvedValue({
      text: JSON.stringify({
        ok: true,
        confidence: 0.5,
        issues: [{ severity: 'critical', message: 'ціни зламані' }],
        summaryUk: 'проблема',
      }),
    });

    const result = await verifyCatalogImportDraft(draft);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.severity).toBe('critical');
  });

  it('allows confirm path when Claude falls back', async () => {
    askClaude.mockResolvedValue({
      text: '',
      fallback: 'timeout',
    });

    const result = await verifyCatalogImportDraft(draft);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});
