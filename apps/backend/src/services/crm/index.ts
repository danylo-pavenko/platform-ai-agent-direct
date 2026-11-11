export * from './types.js';
export {
  getCrmAdapter,
  listRegisteredCrmProviders,
  _resetCrmAdapterForTests,
} from './registry.js';
export {
  getCrmRouting,
  resolveCrmProvider,
  getCrmForAction,
  isCrmRoutingLocalOnly,
  localOnlyCrmRouting,
  invalidateCrmRoutingCache,
} from '../../lib/crm-routing.js';
