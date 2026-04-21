/**
 * CRM adapter registry — pick the active provider once and let all
 * consumers get the same instance via getCrmAdapter().
 *
 * Provider selection: CRM_PROVIDER env var ("keycrm" by default).
 * When a second provider is added, register it here and extend the
 * dispatch switch. No consumer code changes needed.
 */

import { config } from '../../config.js';
import type { CrmAdapter } from './types.js';
import { keycrmAdapter } from './keycrm.js';

let _instance: CrmAdapter | null = null;

export function getCrmAdapter(): CrmAdapter {
  if (_instance) return _instance;

  const provider = (config.CRM_PROVIDER ?? 'keycrm').toLowerCase();

  switch (provider) {
    case 'keycrm':
      _instance = keycrmAdapter;
      break;
    default:
      throw new Error(
        `Unknown CRM_PROVIDER "${provider}". Supported: keycrm`,
      );
  }

  return _instance;
}

/** Test-only: reset the cached adapter so a different provider can be mocked. */
export function _resetCrmAdapterForTests(): void {
  _instance = null;
}
