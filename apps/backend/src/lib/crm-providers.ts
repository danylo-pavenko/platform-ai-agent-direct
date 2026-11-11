/**
 * CRM provider registry types — extensible list for multi-CRM tenants.
 */

export const CRM_PROVIDER_NAMES = ['keycrm', 'cleverbox', 'beautypro', 'altegio'] as const;
export type CrmProviderName = (typeof CRM_PROVIDER_NAMES)[number];

/** Routing target: a vendor, or local-DB-only (no CRM HTTP). */
export type CrmRouteTarget = CrmProviderName | 'none';

export type CrmAction =
  | 'catalog'
  | 'services'
  | 'branches'
  | 'order'
  | 'lead'
  | 'booking'
  | 'client_upsert';

/** Ukrainian label when tenant has no CRM connected / route is none. */
export const CRM_NOT_CONNECTED_LABEL = 'CRM не підключена';

export function isCrmProviderName(value: string): value is CrmProviderName {
  return (CRM_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function isCrmRouteTarget(value: string): value is CrmRouteTarget {
  return value === 'none' || isCrmProviderName(value);
}

export function providerDisplayName(name: CrmProviderName): string {
  if (name === 'keycrm') return 'KeyCRM';
  if (name === 'cleverbox') return 'CleverBOX';
  if (name === 'beautypro') return 'BeautyPro';
  if (name === 'altegio') return 'Altegio';
  return name;
}

export function routeTargetDisplayName(target: CrmRouteTarget | null | undefined): string {
  if (!target || target === 'none') return CRM_NOT_CONNECTED_LABEL;
  return providerDisplayName(target);
}
