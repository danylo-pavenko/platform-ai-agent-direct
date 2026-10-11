export type SyncSource = 'crm' | 'file';
export type CrmPane = 'runs' | 'services';
export type FilePane = 'import' | 'products' | 'matches';

export type SyncRouteState = {
  source: SyncSource;
  crmPane: CrmPane;
  filePane: FilePane;
};

const DEFAULT_STATE: SyncRouteState = {
  source: 'crm',
  crmPane: 'runs',
  filePane: 'import',
};

/** Map location.hash → tab state. */
export function parseSyncHash(hash: string): SyncRouteState {
  const raw = hash.replace(/^#/, '').trim().toLowerCase();
  if (!raw || raw === 'crm' || raw === 'crm-runs') {
    return { ...DEFAULT_STATE, source: 'crm', crmPane: 'runs' };
  }
  if (raw === 'crm-services') {
    return { ...DEFAULT_STATE, source: 'crm', crmPane: 'services' };
  }
  if (raw === 'file' || raw === 'file-import') {
    return { ...DEFAULT_STATE, source: 'file', filePane: 'import' };
  }
  if (raw === 'file-products') {
    return { ...DEFAULT_STATE, source: 'file', filePane: 'products' };
  }
  if (raw === 'file-matches') {
    return { ...DEFAULT_STATE, source: 'file', filePane: 'matches' };
  }
  return { ...DEFAULT_STATE };
}

export function syncStateToHash(state: SyncRouteState): string {
  if (state.source === 'crm') {
    return state.crmPane === 'services' ? '#crm-services' : '#crm';
  }
  if (state.filePane === 'products') return '#file-products';
  if (state.filePane === 'matches') return '#file-matches';
  return '#file';
}

export function replaceSyncHash(state: SyncRouteState): void {
  if (typeof history === 'undefined' || !history.replaceState) return;
  const next = syncStateToHash(state);
  if (location.hash === next) return;
  history.replaceState(null, '', next);
}
