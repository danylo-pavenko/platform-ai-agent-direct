/**
 * product-search.ts
 *
 * Real-time product availability lookup, built on top of the CrmAdapter.
 *
 * Used when a client shares an Instagram post with a product photo -
 * we extract keywords from the post caption and search the CRM for
 * matching ACTIVE products (not archived) that have stock > 0.
 *
 * Why query the CRM directly instead of the local catalog.txt?
 * catalog.txt is a snapshot for prompt context (text only, no quantities).
 * For availability checks we need live quantity data, so we hit the API.
 *
 * To avoid hammering the API on every message, this is only triggered
 * when the incoming message contains a shared post attachment.
 */

import pino from 'pino';
import { getCrmAdapter } from './crm/index.js';
import type { CrmOffer } from './crm/index.js';

const log = pino({ name: 'product-search' });

// How many products to fetch from CRM search results.
// Keeps the context injected into Claude's prompt concise.
const MAX_PRODUCT_RESULTS = 5;

// Max offers (variants) to show per product.
const MAX_OFFERS_PER_PRODUCT = 10;

// ── Formatting helpers ─────────────────────────────────────────────────────

/**
 * Formats offer properties (size, color, etc.) into a human-readable string.
 * e.g. [{ name: "Розмір", value: "M" }, { name: "Колір", value: "Чорний" }]
 * → "Розмір: M, Колір: Чорний"
 */
function formatVariantProps(properties: CrmOffer['properties']): string {
  if (!properties || properties.length === 0) return '';
  return properties.map((p) => `${p.name}: ${p.value}`).join(', ');
}

/**
 * Formats a price range string.
 * e.g. min=1200, max=1500 → "1200–1500₴"
 *      min=1200, max=1200 → "1200₴"
 */
function formatPrice(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'ціна уточнюється';
  if (min === null) return `${max}₴`;
  if (max === null || min === max) return `${min}₴`;
  return `${min}–${max}₴`;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ProductAvailabilityResult {
  /** Human-readable context block to inject into the Claude prompt. */
  contextBlock: string;
  /** Number of products found (0 = nothing matched). */
  matchCount: number;
}

/**
 * Searches the active CRM for products matching the given keywords
 * and returns a formatted availability block for Claude's context.
 *
 * Filters applied:
 *   1. CRM-side: is_archived=0, name search
 *   2. Client-side: only products whose offers have available stock > 0
 *
 * The returned `contextBlock` is injected into the user message when
 * a shared post is detected, giving Claude real-time availability data
 * without needing a separate tool call.
 *
 * @param keywords  Extracted from the shared post caption or image context.
 * @returns         Formatted string + match count.
 */
export async function searchActiveProductsForContext(
  keywords: string,
): Promise<ProductAvailabilityResult> {
  const cleanKeywords = keywords.trim().slice(0, 100); // Prevent excessively long queries

  if (!cleanKeywords) {
    return { contextBlock: '', matchCount: 0 };
  }

  const crm = getCrmAdapter();
  log.info({ keywords: cleanKeywords, provider: crm.name }, 'Searching active products');

  let products;
  try {
    products = await crm.searchProducts({
      nameQuery: cleanKeywords,
      activeOnly: true,
      limit: MAX_PRODUCT_RESULTS,
    });
  } catch (err) {
    log.error({ err, keywords: cleanKeywords }, 'CRM product search failed');
    return { contextBlock: '', matchCount: 0 };
  }

  if (products.length === 0) {
    log.info({ keywords: cleanKeywords }, 'No products found for keywords');
    return { contextBlock: '', matchCount: 0 };
  }

  // For each product found, fetch live offer availability in parallel.
  // We skip products that turn out to have zero available stock.
  const productLines: string[] = [];

  const offerResults = await Promise.allSettled(
    products.map(async (product) => {
      const offers = await crm.searchOffers({
        productId: product.id,
        activeOnly: true,
        limit: MAX_OFFERS_PER_PRODUCT,
      }).catch((err) => {
        log.warn({ err, productId: product.id }, 'Failed to fetch offers for product - skipping');
        return [] as CrmOffer[];
      });
      const activeOffers = offers.filter((o) => !o.isArchived && (o.quantity - o.inReserve) > 0);
      return { product, activeOffers };
    }),
  );

  for (const result of offerResults) {
    if (result.status === 'rejected') continue;
    const { product, activeOffers } = result.value;

    // Skip products with no available variants whatsoever
    if (activeOffers.length === 0 && product.quantity <= 0) {
      log.debug(
        { productId: product.id, name: product.name },
        'Skipping product - no available stock',
      );
      continue;
    }

    const priceStr = formatPrice(product.minPrice, product.maxPrice);

    if (activeOffers.length === 0) {
      // Product has quantity but no offer details (simple product, no variants)
      productLines.push(
        `• ${product.name} | ${priceStr} | В наявності: ${product.quantity} шт`,
      );
    } else {
      // Product has variants - list available sizes/colors
      const variantLines = activeOffers.map((offer) => {
        const variantDesc = formatVariantProps(offer.properties);
        const available = offer.quantity - offer.inReserve;
        return `  – ${variantDesc || 'без варіанту'} | ${offer.price}₴ | ${available} шт`;
      });

      productLines.push(
        `• ${product.name} | від ${priceStr}\n${variantLines.join('\n')}`,
      );
    }
  }

  if (productLines.length === 0) {
    return { contextBlock: '', matchCount: 0 };
  }

  const contextBlock = [
    `Знайдено в каталозі (за запитом "${cleanKeywords}"):`,
    productLines.join('\n'),
    '(Дані про наявність актуальні на момент запиту)',
  ].join('\n');

  log.info(
    { keywords: cleanKeywords, found: productLines.length },
    'Product availability context built',
  );

  return { contextBlock, matchCount: productLines.length };
}

/**
 * Extracts meaningful keywords from an Instagram post caption.
 *
 * Strips hashtags, emojis, and links - keeps only the descriptive words
 * that are likely to match a product name in the CRM.
 *
 * @example
 * extractKeywordsFromCaption("Nike Air Max 90 🔥 #кросівки #nike")
 * → "Nike Air Max 90"
 */
export function extractKeywordsFromCaption(caption: string): string {
  return caption
    // Remove URLs
    .replace(/https?:\/\/\S+/g, '')
    // Remove hashtags
    .replace(/#\S+/g, '')
    // Remove emoji (basic Unicode ranges)
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // Remove extra punctuation / special chars (keep Cyrillic, Latin, digits, spaces)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    // Keep first 80 chars - a product name is never this long
    .slice(0, 80);
}
