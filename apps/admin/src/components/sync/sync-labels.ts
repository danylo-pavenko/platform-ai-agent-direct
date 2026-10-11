export interface SyncCounts {
  categories?: number;
  products?: number;
  offers?: number;
  services?: number;
  masters?: number;
}

export interface SyncArtifacts {
  catalogPath?: string;
  servicesPath?: string;
  mastersPath?: string;
  sources?: Record<string, { provider?: string; count?: number; error?: string; skipped?: boolean }>;
}

export interface SyncRun {
  id: string;
  status: 'running' | 'ok' | 'error';
  provider?: string;
  syncType?: string;
  startedAt: string;
  finishedAt?: string | null;
  counts?: SyncCounts;
  artifacts?: SyncArtifacts;
  errorMessage?: string | null;
}

export interface SyncedService {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  categoryName?: string;
  provider: string;
  branchPrices?: Array<{ branchId: string; branchName: string; price: number }>;
  priceRows?: Array<{
    branchId: string;
    positionId?: string;
    positionName?: string;
    price: number;
  }>;
}

export function sourceLabel(key: string): string {
  const map: Record<string, string> = {
    categories: 'Категорії',
    products: 'Товари',
    offers: 'Варіанти',
    services: 'Послуги',
    masters: 'Майстри',
    branches: 'Філії',
  };
  return map[key] ?? key;
}

export function providerLabel(p?: string): string {
  if (!p) return '—';
  if (p === 'keycrm') return 'KeyCRM';
  if (p === 'cleverbox') return 'CleverBOX';
  if (p === 'beautypro') return 'BeautyPro';
  if (p === 'altegio') return 'Altegio';
  return p;
}

export function providerColor(p?: string): string {
  if (p === 'cleverbox') return 'deep-purple';
  if (p === 'beautypro') return 'pink-darken-2';
  if (p === 'altegio') return 'teal-darken-2';
  if (p === 'keycrm') return 'green-darken-1';
  return 'grey';
}

export function syncTypeLabel(t?: string): string {
  if (!t) return 'каталог';
  const map: Record<string, string> = {
    catalog: 'Каталог товарів',
    services: 'Послуги',
    branches: 'Філії',
    full: 'Повна',
  };
  return map[t] ?? t;
}

export function artifactSummary(item: SyncRun): string {
  const parts: string[] = [];
  if (item.artifacts?.catalogPath) parts.push('catalog.txt');
  if (item.artifacts?.servicesPath) parts.push('services-live.txt');
  if (item.artifacts?.mastersPath) parts.push('masters-live.txt');
  return parts.join(', ');
}

export function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('uk-UA');
}

export function calcDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return '-';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms} мс`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} хв ${remainingSeconds} с`;
}

export function statusLabel(status: SyncRun['status']): string {
  switch (status) {
    case 'running':
      return 'В процесі';
    case 'ok':
      return 'Успішно';
    case 'error':
      return 'Помилка';
    default:
      return status;
  }
}

export function statusColor(status: SyncRun['status']): string {
  switch (status) {
    case 'running':
      return 'blue';
    case 'ok':
      return 'green';
    case 'error':
      return 'red';
    default:
      return 'grey';
  }
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  return `${price} ₴`;
}

export function uniqueBranchCount(item: SyncedService): number {
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

export function formatServicePriceDisplay(item: SyncedService): string {
  const fromRows = (item.priceRows ?? [])
    .map((r) => r.price)
    .filter((p) => typeof p === 'number' && p > 0);
  if (fromRows.length > 0) {
    const min = Math.min(...fromRows);
    const max = Math.max(...fromRows);
    return min === max ? formatPrice(min) : `${min}–${max} ₴`;
  }
  return formatPrice(item.price);
}

export function formatServiceGradeBreakdown(item: SyncedService): string {
  const byName = new Map<string, number>();
  for (const row of item.priceRows ?? []) {
    const name = row.positionName?.trim();
    if (!name || !(row.price > 0)) continue;
    const prev = byName.get(name);
    if (prev == null || row.price > prev) byName.set(name, row.price);
  }
  if (byName.size === 0) return '';
  return [...byName.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'uk'))
    .map(([name, price]) => `${name}: ${price}`)
    .join('; ');
}

export function formatManualPrice(min: number | null, max: number | null): string {
  if (min == null && max == null) return '—';
  if (min == null) return `${max} ₴`;
  if (max == null || min === max) return `${min} ₴`;
  return `${min}–${max} ₴`;
}

export function formatOfferLine(o: {
  sku: string | null;
  price: number;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
}): string {
  const variant = o.properties.map((p) => p.value).filter(Boolean).join(', ') || '—';
  const sku = o.sku ? ` · ${o.sku}` : '';
  return `${variant} · ${o.price} ₴ · ${o.quantity} шт${sku}`;
}

export function latestSourceChips(run: SyncRun | null): Array<{
  label: string;
  count: number | undefined;
  provider: string;
}> {
  if (!run) return [];
  if (!run.artifacts?.sources) {
    if (!run.counts) return [];
    const chips: Array<{ label: string; count: number; provider: string }> = [];
    if (run.counts.products != null) {
      chips.push({
        label: 'Товари',
        count: run.counts.products,
        provider: providerLabel(run.provider),
      });
    }
    if (run.counts.services != null) {
      chips.push({
        label: 'Послуги',
        count: run.counts.services,
        provider: providerLabel(run.provider),
      });
    }
    if (run.counts.masters != null) {
      chips.push({
        label: 'Майстри',
        count: run.counts.masters,
        provider: providerLabel(run.provider),
      });
    }
    return chips;
  }
  return Object.entries(run.artifacts.sources).map(([key, src]) => ({
    label: sourceLabel(key),
    count: src.count,
    provider: providerLabel(src.provider),
  }));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
