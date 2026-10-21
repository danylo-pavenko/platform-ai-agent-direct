/**
 * Sync page navigation + pane resolution (shared by SyncView and flow tests).
 */

import {
  type CrmPane,
  type FilePane,
  type SyncRouteState,
  type SyncSource,
  parseSyncHash,
  syncStateToHash,
} from './sync-hash';
import type { SyncedService } from './sync-labels';

export type SyncPaneId =
  | 'crm-runs'
  | 'crm-services'
  | 'file-import'
  | 'file-products'
  | 'file-matches';

export function resolveSyncPane(state: SyncRouteState): SyncPaneId {
  if (state.source === 'crm') {
    return state.crmPane === 'services' ? 'crm-services' : 'crm-runs';
  }
  if (state.filePane === 'products') return 'file-products';
  if (state.filePane === 'matches') return 'file-matches';
  return 'file-import';
}

export function syncHeaderSubtitle(state: SyncRouteState): string {
  if (state.source === 'file') {
    if (state.filePane === 'products') return 'Перегляд товарів з імпортованого CSV.';
    if (state.filePane === 'matches') return 'Звʼязки файлового каталогу з CRM.';
    return 'Імпорт CSV (Shop-Express), пріоритет пошуку.';
  }
  if (state.crmPane === 'services') {
    return 'Знімок послуг і цін після останньої синхронізації CRM.';
  }
  return 'Каталог і послуги з CRM. Автозапуск раз на добу (~04:00 за часовим поясом салону) + ручний тригер. CSV — окрема вкладка.';
}

/** Apply L1 source change; keep existing L2 panes. */
export function withSyncSource(state: SyncRouteState, source: SyncSource): SyncRouteState {
  return { ...state, source };
}

export function withCrmPane(state: SyncRouteState, crmPane: CrmPane): SyncRouteState {
  return { ...state, source: 'crm', crmPane };
}

export function withFilePane(state: SyncRouteState, filePane: FilePane): SyncRouteState {
  return { ...state, source: 'file', filePane };
}

export function filterSyncedServices(
  services: SyncedService[],
  search: string,
): SyncedService[] {
  const q = search.trim().toLowerCase();
  if (!q) return services;
  return services.filter((s) => {
    const grades = (s.priceRows ?? []).map((r) => r.positionName ?? '').join(' ');
    const hay = [s.name, s.categoryName ?? '', s.id, s.provider, grades]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Simulate owner clicking through Sync: hash → pane → exclusive content.
 */
export function simulateSyncOwnerJourney(hashes: string[]): Array<{
  hashIn: string;
  state: SyncRouteState;
  pane: SyncPaneId;
  hashOut: string;
  subtitle: string;
}> {
  return hashes.map((hashIn) => {
    const state = parseSyncHash(hashIn);
    return {
      hashIn,
      state,
      pane: resolveSyncPane(state),
      hashOut: syncStateToHash(state),
      subtitle: syncHeaderSubtitle(state),
    };
  });
}
