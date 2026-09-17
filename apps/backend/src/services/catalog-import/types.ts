/**
 * Shared types for CSV → CrmProduct/CrmOffer catalog import.
 */

import type { CrmCategory, CrmOffer, CrmProduct } from '../crm/types.js';

export const CATALOG_IMPORT_SOURCES = ['shop_express'] as const;
export type CatalogImportSource = (typeof CATALOG_IMPORT_SOURCES)[number];

export const CATALOG_SOURCE_PRIORITIES = ['file', 'crm'] as const;
export type CatalogSourcePriority = (typeof CATALOG_SOURCE_PRIORITIES)[number];

export const CATALOG_PRICE_PREFERENCES = ['file', 'crm'] as const;
export type CatalogPricePreference = (typeof CATALOG_PRICE_PREFERENCES)[number];

export type CatalogMatchMethod = 'sku' | 'name' | 'manual';
export type CatalogMatchConfidence = 'high' | 'medium';

export interface CatalogProductMatch {
  manualProductId: number;
  crmProductId: number;
  method: CatalogMatchMethod;
  confidence: CatalogMatchConfidence;
  updatedAt: string;
}

export interface CatalogImportDraft {
  source: CatalogImportSource;
  products: CrmProduct[];
  offers: CrmOffer[];
  categories: CrmCategory[];
  stats: CatalogImportStats;
  /** Small sample of raw→mapped rows for Claude verify / UI. */
  sampleRows: CatalogImportSampleRow[];
}

export interface CatalogImportStats {
  rowCount: number;
  productCount: number;
  offerCount: number;
  categoryCount: number;
  availableOffers: number;
  unavailableOffers: number;
  priceMin: number | null;
  priceMax: number | null;
  parseWarnings: string[];
}

export interface CatalogImportSampleRow {
  rawName: string;
  rawPrice: string;
  rawSku: string;
  rawModification: string;
  rawAvailable: string;
  mappedProductId: number;
  mappedOfferId: number;
  mappedPrice: number;
  mappedQty: number;
  mappedArchived: boolean;
}

export interface CatalogVerifyResult {
  ok: boolean;
  confidence: number;
  issues: Array<{ severity: 'critical' | 'warning'; message: string }>;
  summaryUk: string;
}

export interface CatalogImportSettings {
  sourcePriority: CatalogSourcePriority;
  /** Which price the agent should quote when file↔CRM are matched. */
  pricePreference: CatalogPricePreference;
  lastImportAt: string | null;
  lastSource: CatalogImportSource | null;
  productCount: number;
  offerCount: number;
  verifyStatus: 'ok' | 'warnings' | 'failed' | 'none';
  verifySummary: string | null;
}

export const DEFAULT_CATALOG_IMPORT_SETTINGS: CatalogImportSettings = {
  sourcePriority: 'file',
  pricePreference: 'file',
  lastImportAt: null,
  lastSource: null,
  productCount: 0,
  offerCount: 0,
  verifyStatus: 'none',
  verifySummary: null,
};

export const CATALOG_IMPORT_SETTING_KEY = 'catalog_import';
