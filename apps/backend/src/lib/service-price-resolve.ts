/**
 * Resolve client-facing service prices by master grade (BeautyPro positions).
 */

import type { CrmServiceItem, CrmServicePriceRow } from '../services/crm/types.js';

export type ResolvedServicePrice =
  | { kind: 'fixed'; price: number; positionName?: string }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unknown' };

function positivePrices(rows: CrmServicePriceRow[]): number[] {
  return rows.map((r) => r.price).filter((p) => typeof p === 'number' && p > 0);
}

/** Unique grade labels with representative price (max per grade name). */
export function gradePriceBreakdown(
  item: CrmServiceItem,
): Array<{ positionName: string; price: number }> {
  const rows = item.priceRows ?? [];
  const byName = new Map<string, number>();
  for (const row of rows) {
    if (!(row.price > 0)) continue;
    const name = row.positionName?.trim();
    if (!name) continue;
    const prev = byName.get(name);
    if (prev == null || row.price > prev) byName.set(name, row.price);
  }
  return [...byName.entries()]
    .map(([positionName, price]) => ({ positionName, price }))
    .sort((a, b) => a.price - b.price || a.positionName.localeCompare(b.positionName, 'uk'));
}

export function uniqueBranchCount(item: CrmServiceItem): number {
  const ids = new Set<string>();
  for (const row of item.priceRows ?? []) {
    if (row.branchId) ids.add(row.branchId);
  }
  if (ids.size > 0) return ids.size;
  for (const b of item.branchPrices ?? []) {
    if (b.branchId) ids.add(b.branchId);
  }
  return ids.size;
}

/**
 * Resolve quote for a service.
 * - With master positions: max matching priceRow (premium > top by price).
 * - No matching row for master's grades → unavailable (incomplete spectrum).
 * - Without master → min–max range across client prices.
 */
export function resolveServicePrice(
  service: CrmServiceItem,
  opts?: {
    branchId?: string | null;
    masterPositionIds?: string[] | null;
  },
): ResolvedServicePrice {
  const rows = (service.priceRows ?? []).filter((r) => r.price > 0);
  const masterIds = (opts?.masterPositionIds ?? []).filter(Boolean);
  const branchId = opts?.branchId?.trim() || undefined;

  if (masterIds.length > 0) {
    if (rows.length === 0) {
      // Legacy snapshot without priceRows — fall back to base price.
      if (service.price > 0) return { kind: 'fixed', price: service.price };
      return { kind: 'unknown' };
    }

    let matched = rows.filter(
      (r) => r.positionId && masterIds.includes(r.positionId),
    );
    if (branchId) {
      const atBranch = matched.filter((r) => r.branchId === branchId);
      if (atBranch.length > 0) matched = atBranch;
    }

    if (matched.length === 0) {
      return {
        kind: 'unavailable',
        reason:
          'Цей майстер (рівень) не має ціни на цю послугу в CRM — оберіть іншого майстра або грейд.',
      };
    }

    const best = matched.reduce((a, b) => (b.price > a.price ? b : a));
    return {
      kind: 'fixed',
      price: best.price,
      positionName: best.positionName,
    };
  }

  const prices = positivePrices(rows);
  if (prices.length === 0) {
    const fromBranches = (service.branchPrices ?? [])
      .map((b) => b.price)
      .filter((p) => p > 0);
    if (fromBranches.length > 0) {
      const min = Math.min(...fromBranches);
      const max = Math.max(...fromBranches);
      return min === max ? { kind: 'fixed', price: min } : { kind: 'range', min, max };
    }
    if (service.price > 0) return { kind: 'fixed', price: service.price };
    return { kind: 'unknown' };
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? { kind: 'fixed', price: min } : { kind: 'range', min, max };
}

export function formatResolvedPrice(resolved: ResolvedServicePrice): string {
  switch (resolved.kind) {
    case 'fixed':
      return `від ${resolved.price} ₴`;
    case 'range':
      return `${resolved.min}–${resolved.max} ₴`;
    case 'unavailable':
      return 'недоступно для цього майстра';
    case 'unknown':
      return 'ціна за запитом';
  }
}

/** Short grade breakdown for catalog / Sync UI (only grades present on the service). */
export function formatGradeBreakdown(item: CrmServiceItem): string {
  const grades = gradePriceBreakdown(item);
  if (grades.length === 0) return '';
  return grades.map((g) => `${g.positionName}: ${g.price}`).join('; ');
}
