/**
 * CRM adapter registry — multi-provider cache keyed by provider name.
 */

import { config } from '../../config.js';
import { isCrmProviderName, type CrmProviderName } from '../../lib/crm-providers.js';
import type { CrmAdapter } from './types.js';
import { keycrmAdapter } from './keycrm.js';
import { cleverboxAdapter } from './cleverbox.js';
import { beautyproAdapter } from './beautypro.js';

const _instances = new Map<CrmProviderName, CrmAdapter>();

function createAdapter(name: CrmProviderName): CrmAdapter {
  switch (name) {
    case 'keycrm':
      return keycrmAdapter;
    case 'cleverbox':
      return cleverboxAdapter;
    case 'beautypro':
      return beautyproAdapter;
    default:
      throw new Error(`Unknown CRM provider "${name}"`);
  }
}

/**
 * Returns adapter for the given provider, or env default when omitted.
 * Cached per provider — safe to call on every request.
 */
export function getCrmAdapter(provider?: CrmProviderName): CrmAdapter {
  const name =
    provider ??
    (isCrmProviderName((config.CRM_PROVIDER ?? 'keycrm').toLowerCase())
      ? ((config.CRM_PROVIDER ?? 'keycrm').toLowerCase() as CrmProviderName)
      : 'keycrm');

  const cached = _instances.get(name);
  if (cached) return cached;

  const adapter = createAdapter(name);
  _instances.set(name, adapter);
  return adapter;
}

export function listRegisteredCrmProviders(): CrmProviderName[] {
  return ['keycrm', 'cleverbox', 'beautypro'];
}

/** Test-only: reset cached adapters. */
export function _resetCrmAdapterForTests(): void {
  _instances.clear();
}
