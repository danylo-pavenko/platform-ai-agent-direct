/**
 * CRM adapter interface — abstracts the CRM backend (KeyCRM, future providers)
 * behind a single contract so consumers (sync-worker, product-search, order
 * submission) are decoupled from vendor-specific HTTP.
 *
 * Read methods are mandatory. Write methods are optional — a provider that
 * cannot support them (e.g. a read-only ETL export) simply omits them, and
 * the caller falls back to local-DB-only behaviour.
 */

// ── Shared entity types ────────────────────────────────────────────────────

export interface CrmCategory {
  id: number;
  name: string;
  parentId: number | null;
}

export interface CrmProduct {
  id: number;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  attachmentsData: string[];
  quantity: number;
  currencyCode: string;
  minPrice: number | null;
  maxPrice: number | null;
  hasOffers: boolean;
  isArchived: boolean;
  categoryId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmOffer {
  id: number;
  productId: number;
  sku: string | null;
  barcode: string | null;
  thumbnailUrl: string | null;
  price: number;
  purchasedPrice: number;
  quantity: number;
  inReserve: number;
  properties: Array<{ name: string; value: string }>;
  isArchived: boolean;
  product?: CrmProduct;
}

// ── Search / filter params ─────────────────────────────────────────────────

export interface ProductSearchParams {
  /** Substring match on product name (CRM-provider-specific search). */
  nameQuery?: string;
  /** Exclude archived products (default true). */
  activeOnly?: boolean;
  /** Max number of products to return (default 5). */
  limit?: number;
}

export interface OfferSearchParams {
  productId?: number;
  activeOnly?: boolean;
  limit?: number;
}

// ── Client / order write types (used in Phase 2) ───────────────────────────

export interface CrmClientMatch {
  crmBuyerId?: string;
  phone?: string;
  email?: string;
  /** Instagram handle without @, used for custom-field match or note search. */
  instagramUsername?: string;
}

export interface CrmClientInput {
  fullName: string;
  phone?: string;
  email?: string;
  note?: string;
  instagramUsername?: string;
  shipping?: {
    city?: string;
    address?: string;
    warehouseRef?: string;
  };
  /**
   * Provider-specific custom field values, keyed by field UUID/key
   * (see listCustomFields). Used for extensibility — shop owner maps
   * local attribute → CRM custom field.
   */
  customFields?: Array<{ key: string; value: string }>;
}

export interface CrmOrderItem {
  name: string;
  variant?: string;
  price: number;
  qty: number;
  /** CRM-side offer ID, if we could resolve it from local DB. */
  offerId?: number;
}

export interface CrmOrderInput {
  /**
   * CRM buyer reference. KeyCRM /order does not accept buyer_id in the
   * request body and always resolves the buyer by phone/email/name, so
   * this is kept here for adapters that do support it (future providers)
   * — our KeyCRM adapter falls back to `buyer` nested contacts below.
   */
  crmBuyerId?: string;
  /** Buyer contact snapshot — KeyCRM uses this to match/create a buyer. */
  buyer: {
    fullName: string;
    phone?: string;
    email?: string;
  };
  items: CrmOrderItem[];
  note?: string;
  paymentMethod?: 'card' | 'transfer' | 'cod';
  shipping?: {
    city: string;
    npBranch: string;
  };
  /** CRM-provider source id (KeyCRM: source_id; defaults to config). */
  sourceId?: number;
  customFields?: Array<{ key: string; value: string }>;
}

export interface CrmCustomFieldDef {
  /** Provider key/UUID used in write calls. */
  key: string;
  /** Human-readable field name. */
  name: string;
  /** Where this field lives (buyer, order, lead/pipeline card, etc.). */
  scope: 'buyer' | 'order' | 'lead';
  /** Field type hint (text, number, select, multi-select, date...). */
  type: string;
  /** Allowed values for select/multi-select. */
  options?: string[];
}

/**
 * Inputs for creating a presale lead (pipeline card in KeyCRM).
 * Kept separate from CrmOrderInput because a lead is pre-sale context
 * (brief / intent / segment) rather than a confirmed transaction.
 */
export interface CrmLeadInput {
  /** Short title for the card (fallback: card id). */
  title?: string;
  /** Optional pipeline id — omit to let the CRM pick the default pipeline. */
  pipelineId?: number;
  /** Source id (defaults to KEYCRM_DEFAULT_SOURCE_ID when absent). */
  sourceId?: number;
  /** Free-text summary the manager will read first. */
  managerComment?: string;
  /** Existing CRM buyer id, if the client has already been mirrored. */
  crmBuyerId?: string;
  /** Buyer contact snapshot used when crmBuyerId is not yet known. */
  contact: {
    fullName?: string;
    phone?: string;
    email?: string;
  };
  customFields?: Array<{ key: string; value: string }>;
}

// ── The adapter itself ─────────────────────────────────────────────────────

export interface CrmAdapter {
  readonly name: string;

  // Reads (mandatory)
  fetchCategories(): Promise<CrmCategory[]>;
  fetchProducts(): Promise<CrmProduct[]>;
  fetchOffers(): Promise<CrmOffer[]>;

  // Runtime search (mandatory — used by product-search on IG shared posts)
  searchProducts(params: ProductSearchParams): Promise<CrmProduct[]>;
  searchOffers(params: OfferSearchParams): Promise<CrmOffer[]>;

  // Writes (optional — Phase 2)
  findClient?(match: CrmClientMatch): Promise<{ crmBuyerId: string } | null>;
  upsertClient?(
    crmBuyerId: string | null,
    input: CrmClientInput,
  ): Promise<{ crmBuyerId: string }>;
  createOrder?(input: CrmOrderInput): Promise<{ crmOrderId: string }>;

  /**
   * Creates a lead / pipeline card (leadgen mode).
   * Providers that don't have a native pipeline concept may alias this to
   * createOrder with a draft status, but should return a distinct lead id
   * so the brief mirror is idempotent.
   */
  createLead?(input: CrmLeadInput): Promise<{ crmLeadId: string }>;

  // Custom fields discovery (optional — Phase 3)
  listCustomFields?(
    scope: 'buyer' | 'order' | 'lead',
  ): Promise<CrmCustomFieldDef[]>;
}
