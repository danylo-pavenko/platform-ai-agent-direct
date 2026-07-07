/**
 * CRM provider registry types — extensible list for multi-CRM tenants.
 */

export const CRM_PROVIDER_NAMES = ['keycrm', 'cleverbox'] as const;
export type CrmProviderName = (typeof CRM_PROVIDER_NAMES)[number];

export type CrmAction =
  | 'catalog'
  | 'services'
  | 'branches'
  | 'order'
  | 'lead'
  | 'booking'
  | 'client_upsert';

export function isCrmProviderName(value: string): value is CrmProviderName {
  return (CRM_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function providerDisplayName(name: CrmProviderName): string {
  if (name === 'keycrm') return 'KeyCRM';
  if (name === 'cleverbox') return 'CleverBOX';
  return name;
}
