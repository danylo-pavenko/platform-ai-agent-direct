import type { CatalogImportDraft, CatalogImportSource } from '../types.js';
import { parseShopExpressCsv } from './shop-express.js';

export function parseCatalogCsv(
  source: CatalogImportSource,
  csvText: string,
): CatalogImportDraft {
  switch (source) {
    case 'shop_express':
      return parseShopExpressCsv(csvText);
    default: {
      const _exhaustive: never = source;
      throw new Error(`Невідоме джерело каталогу: ${_exhaustive}`);
    }
  }
}

export { parseShopExpressCsv, parseShopExpressPrice, parseDelimitedCsv } from './shop-express.js';
