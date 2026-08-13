import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: { INSTANCE_ID: 'sb' },
}));

vi.mock('./integration-config.js', () => ({ invalidateIntegrationConfigCache: vi.fn() }));
vi.mock('./runtime-config.js', () => ({ invalidateRuntimeConfigCache: vi.fn() }));
vi.mock('./agent-config.js', () => ({ invalidateAgentConfigCache: vi.fn() }));
vi.mock('./crm-routing.js', () => ({ invalidateCrmRoutingCache: vi.fn() }));
vi.mock('./crm-write.js', () => ({ invalidateCrmWriteCache: vi.fn() }));
vi.mock('./feature-flags.js', () => ({ invalidateFeatureFlagsCache: vi.fn() }));
vi.mock('./follow-up-config.js', () => ({ invalidateFollowUpConfigCache: vi.fn() }));
vi.mock('./telegram-groups.js', () => ({ invalidateTelegramGroupsCache: vi.fn() }));
vi.mock('./crm-field-mappings.js', () => ({ invalidateCrmFieldMappingsCache: vi.fn() }));

import {
  buildPm2AppNames,
  parsePm2Targets,
  DEFAULT_PM2_TARGETS,
  _resetPm2RestartCooldownForTests,
} from './pm2-restart.js';

describe('parsePm2Targets', () => {
  it('defaults to api+bot+sync', () => {
    expect(parsePm2Targets(undefined)).toEqual(DEFAULT_PM2_TARGETS);
    expect(parsePm2Targets(null)).toEqual(DEFAULT_PM2_TARGETS);
    expect(parsePm2Targets([])).toEqual(DEFAULT_PM2_TARGETS);
  });

  it('accepts allowlisted targets', () => {
    expect(parsePm2Targets(['bot', 'api'])).toEqual(['bot', 'api']);
  });

  it('rejects unknown targets', () => {
    expect(parsePm2Targets(['api', 'evil'])).toBeNull();
    expect(parsePm2Targets('api')).toBeNull();
  });
});

describe('buildPm2AppNames', () => {
  beforeEach(() => {
    _resetPm2RestartCooldownForTests();
  });

  it('prefixes with instance id', () => {
    expect(buildPm2AppNames(['api', 'bot', 'sync'], 'tkp')).toEqual([
      'TKP-api',
      'TKP-bot',
      'TKP-sync',
    ]);
  });

  it('dedupes targets', () => {
    expect(buildPm2AppNames(['api', 'api', 'bot'], 'sb')).toEqual(['SB-api', 'SB-bot']);
  });
});
