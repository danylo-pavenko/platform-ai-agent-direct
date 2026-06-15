export interface KeycrmOrderArchiveSnapshot {
  closedAt: string | null;
  statusAlias: string | null;
  statusName: string | null;
}

const ARCHIVED_ALIASES = new Set([
  'canceled',
  'cancelled',
  'archived',
  'archive',
  'rejected',
  'refused',
  'deleted',
]);

/** True when KeyCRM marks the order closed or in a terminal/archive status. */
export function isKeycrmOrderArchived(snapshot: KeycrmOrderArchiveSnapshot): boolean {
  if (snapshot.closedAt) return true;

  const alias = (snapshot.statusAlias ?? '').trim().toLowerCase();
  if (alias && ARCHIVED_ALIASES.has(alias)) return true;

  const name = (snapshot.statusName ?? '').trim().toLowerCase();
  if (!name) return false;

  return (
    name.includes('архів') ||
    name.includes('скасов') ||
    name.includes('відхил') ||
    name.includes('cancel') ||
    name.includes('reject')
  );
}
