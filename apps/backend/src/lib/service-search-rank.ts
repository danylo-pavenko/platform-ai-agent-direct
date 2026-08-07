/**
 * CRM-agnostic service ranking (BeautyPro, CleverBOX, …).
 * Mirrors product search tokenize/score patterns in catalog-index.ts.
 */

import { broadenServiceQueries } from './booking-lookup-format.js';
import type { CrmServiceItem } from '../services/crm/types.js';
import {
  formatGradeBreakdown,
  formatResolvedPrice,
  resolveServicePrice,
} from './service-price-resolve.js';

export const DEFAULT_SERVICE_SEARCH_LIMIT = 12;
export const MAX_SERVICE_SEARCH_LIMIT = 20;

/** Tokenize a service search query (Cyrillic + Latin, min 2 chars). */
export function tokenizeServiceQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function isGenderToken(token: string): boolean {
  return /^(чоловіч|жіноч|мужск|женск)/i.test(token);
}

/**
 * Score how well a service matches a query.
 * Word order independent: «чоловічий манікюр» matches «Манікюр чоловічий».
 */
export function scoreServiceMatch(item: CrmServiceItem, query: string): number {
  const tokens = tokenizeServiceQuery(query);
  if (tokens.length === 0) return 0;

  const name = (item.name ?? '').toLowerCase();
  const category = (item.categoryName ?? '').toLowerCase();
  const fullQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name && !category) return 0;

  let nameMatched = 0;
  let categoryMatched = 0;
  for (const token of tokens) {
    if (name.includes(token)) nameMatched++;
    else if (category.includes(token)) categoryMatched++;
  }

  const matched = nameMatched + categoryMatched;
  if (matched === 0) return 0;

  let score = matched / tokens.length;

  if (fullQuery && name.includes(fullQuery)) {
    score += 0.5;
  }
  if (nameMatched === tokens.length) {
    score += 0.25;
  }
  if (categoryMatched > 0 && nameMatched === 0) {
    score -= 0.15;
  } else if (categoryMatched > 0) {
    score += 0.1;
  }

  for (const token of tokens) {
    if (!isGenderToken(token)) continue;
    // Match stem so «чоловічий» hits «чоловічий» / «чоловіча» variants in name
    const stem = token.slice(0, Math.min(6, token.length));
    if (name.includes(token) || (stem.length >= 4 && name.includes(stem))) {
      score += 0.15;
    }
  }

  return score;
}

/** Primary query + broadenServiceQueries, deduped, primary first. */
export function expandServiceQueries(query: string): string[] {
  const primary = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!primary) return [];

  const out: string[] = [primary];
  const seen = new Set<string>([primary]);
  for (const alt of broadenServiceQueries(query)) {
    if (seen.has(alt)) continue;
    seen.add(alt);
    out.push(alt);
  }
  return out;
}

export function clampServiceSearchLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_SERVICE_SEARCH_LIMIT;
  return Math.min(MAX_SERVICE_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

export function rankServices(
  items: CrmServiceItem[],
  query: string,
  limit: number = DEFAULT_SERVICE_SEARCH_LIMIT,
): CrmServiceItem[] {
  const cap = clampServiceSearchLimit(limit);
  const scored: Array<{ item: CrmServiceItem; score: number }> = [];
  for (const item of items) {
    const score = scoreServiceMatch(item, query);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'uk'),
  );
  return scored.slice(0, cap).map((s) => s.item);
}

export type RankAcrossQueriesResult = {
  items: CrmServiceItem[];
  /** Query that best explains the top hit set (primary if it scored anything). */
  usedQuery: string;
  broadenedFrom?: string;
};

/**
 * Score each item against query variants.
 * If the primary query matches anything, rank by primary only (keeps gender/word-order
 * preference). Broader keyword variants run only when primary yields zero hits.
 */
export function rankAcrossQueries(
  items: CrmServiceItem[],
  queries: string[],
  limit: number = DEFAULT_SERVICE_SEARCH_LIMIT,
): RankAcrossQueriesResult {
  const primary = queries[0]?.trim() ?? '';
  if (!primary || items.length === 0) {
    return { items: [], usedQuery: primary };
  }

  const cap = clampServiceSearchLimit(limit);
  const primaryRanked = rankServices(items, primary, cap);
  if (primaryRanked.length > 0) {
    return { items: primaryRanked, usedQuery: primary };
  }

  const bestById = new Map<
    string,
    { item: CrmServiceItem; score: number; query: string }
  >();

  for (const q of queries.slice(1)) {
    if (!q.trim()) continue;
    for (const item of items) {
      const score = scoreServiceMatch(item, q);
      if (score <= 0) continue;
      const prev = bestById.get(item.id);
      if (!prev || score > prev.score) {
        bestById.set(item.id, { item, score, query: q });
      }
    }
  }

  const ranked = [...bestById.values()].sort(
    (a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'uk'),
  );
  const top = ranked.slice(0, cap);

  if (top.length === 0) {
    return { items: [], usedQuery: primary };
  }

  return {
    items: top.map((t) => t.item),
    usedQuery: top[0]!.query,
    broadenedFrom: primary,
  };
}

/** Format price for tool results: range + optional grade breakdown. */
export function formatServicePrice(item: CrmServiceItem): string {
  const resolved = resolveServicePrice(item);
  const base = formatResolvedPrice(resolved);
  if (resolved.kind === 'unavailable' || resolved.kind === 'unknown') return base;
  return base;
}

export function formatServiceLine(item: CrmServiceItem): string {
  const cat = item.categoryName ? ` | ${item.categoryName}` : '';
  const grades = formatGradeBreakdown(item);
  const gradePart = grades ? ` | ${grades}` : '';
  return `[service_id=${item.id}] ${item.name} | ${item.durationMin} хв | ${formatServicePrice(item)}${gradePart}${cat}`;
}
