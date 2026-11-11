import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, config, getIntegrationConfig, getCrmAdapter, providerHasCredentials, providerReadCredentialsReason } =
  vi.hoisted(() => ({
    prismaMock: {
      setting: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
    },
    config: {
      CRM_PROVIDER: 'keycrm' as string,
      CLEVERBOX_API_TOKEN: '' as string,
    },
    getIntegrationConfig: vi.fn(),
    getCrmAdapter: vi.fn(),
    providerHasCredentials: vi.fn(),
    providerReadCredentialsReason: vi.fn(),
  }));

vi.mock('./prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../config.js', () => ({ config }));
vi.mock('./integration-config.js', () => ({ getIntegrationConfig }));
vi.mock('../services/crm/registry.js', () => ({ getCrmAdapter }));
vi.mock('./crm-write.js', () => ({
  providerHasCredentials,
  providerReadCredentialsReason,
}));

import {
  ensureCrmRoutingAfterIntegrations,
  getCrmForAction,
  getCrmRouting,
  invalidateCrmRoutingCache,
  isCrmRoutingLocalOnly,
  localOnlyCrmRouting,
  parseCrmRouting,
  resolveCrmProvider,
} from './crm-routing.js';

describe('parseCrmRouting', () => {
  beforeEach(() => {
    config.CRM_PROVIDER = 'keycrm';
    config.CLEVERBOX_API_TOKEN = '';
  });

  it('parses explicit none / empty enabled as local-only', () => {
    const r = parseCrmRouting({
      mode: 'single',
      default: 'none',
      enabled_providers: [],
      routes: { booking: 'none', order: 'none' },
    });
    expect(r.default).toBe('none');
    expect(r.enabled_providers).toEqual([]);
    expect(r.routes.booking).toBe('none');
    expect(isCrmRoutingLocalOnly(r)).toBe(true);
  });

  it('does not force keycrm when enabled_providers is explicitly empty', () => {
    const r = parseCrmRouting({
      mode: 'single',
      default: 'keycrm',
      enabled_providers: [],
    });
    expect(r.enabled_providers).toEqual([]);
  });

  it('seeds enabled from default when enabled_providers omitted (legacy)', () => {
    const r = parseCrmRouting({ mode: 'single', default: 'beautypro' });
    expect(r.enabled_providers).toContain('beautypro');
    expect(r.default).toBe('beautypro');
  });

  it('uses env none when raw empty', () => {
    config.CRM_PROVIDER = 'none';
    const r = parseCrmRouting(null);
    expect(r.default).toBe('none');
    expect(isCrmRoutingLocalOnly(r)).toBe(true);
  });

  it('allows per-action none in by_action', () => {
    const r = parseCrmRouting({
      mode: 'by_action',
      default: 'keycrm',
      enabled_providers: ['keycrm'],
      routes: { booking: 'none', order: 'keycrm' },
    });
    expect(r.routes.booking).toBe('none');
    expect(r.routes.order).toBe('keycrm');
  });
});

describe('resolveCrmProvider / getCrmForAction', () => {
  beforeEach(() => {
    invalidateCrmRoutingCache();
    config.CRM_PROVIDER = 'keycrm';
    prismaMock.setting.findUnique.mockReset();
    getIntegrationConfig.mockReset();
    getCrmAdapter.mockReset();
    providerReadCredentialsReason.mockReset();
  });

  it('returns null for local-only routing', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: localOnlyCrmRouting(),
    });
    await expect(resolveCrmProvider('booking')).resolves.toBeNull();
    await expect(resolveCrmProvider('order')).resolves.toBeNull();
  });

  it('returns null for by_action route none', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: {
        mode: 'by_action',
        default: 'keycrm',
        enabled_providers: ['keycrm'],
        routes: { booking: 'none', order: 'keycrm' },
      },
    });
    await expect(resolveCrmProvider('booking')).resolves.toBeNull();
    await expect(resolveCrmProvider('order')).resolves.toBe('keycrm');
  });

  it('returns vendor when enabled and configured', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: {
        mode: 'single',
        default: 'beautypro',
        enabled_providers: ['beautypro'],
        routes: {},
      },
    });
    await expect(resolveCrmProvider('services')).resolves.toBe('beautypro');
  });

  it('getCrmForAction returns null when credentials missing', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: {
        mode: 'single',
        default: 'keycrm',
        enabled_providers: ['keycrm'],
        routes: {},
      },
    });
    getIntegrationConfig.mockResolvedValue({ keycrm: { apiKey: '' } });
    providerReadCredentialsReason.mockReturnValue('API ключ KeyCRM не налаштовано');
    await expect(getCrmForAction('catalog')).resolves.toBeNull();
    expect(getCrmAdapter).not.toHaveBeenCalled();
  });

  it('getCrmForAction returns adapter when ready', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: {
        mode: 'single',
        default: 'keycrm',
        enabled_providers: ['keycrm'],
        routes: {},
      },
    });
    getIntegrationConfig.mockResolvedValue({ keycrm: { apiKey: 'k' } });
    providerReadCredentialsReason.mockReturnValue(null);
    const adapter = { name: 'keycrm' };
    getCrmAdapter.mockReturnValue(adapter);
    await expect(getCrmForAction('catalog')).resolves.toEqual({
      provider: 'keycrm',
      adapter,
    });
  });
});

describe('ensureCrmRoutingAfterIntegrations', () => {
  beforeEach(() => {
    invalidateCrmRoutingCache();
    prismaMock.setting.findUnique.mockReset();
    prismaMock.setting.upsert.mockReset();
    getIntegrationConfig.mockReset();
    providerHasCredentials.mockReset();
  });

  it('persists local-only when zero CRM credentials', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: {
        mode: 'single',
        default: 'keycrm',
        enabled_providers: ['keycrm'],
        routes: {},
      },
    });
    getIntegrationConfig.mockResolvedValue({});
    providerHasCredentials.mockReturnValue(false);
    prismaMock.setting.upsert.mockResolvedValue({});

    const result = await ensureCrmRoutingAfterIntegrations();
    expect(result.applied).toBe('local_only');
    expect(result.config.default).toBe('none');
    expect(prismaMock.setting.upsert).toHaveBeenCalled();
  });

  it('noops when already local-only and zero credentials', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({
      value: localOnlyCrmRouting(),
    });
    getIntegrationConfig.mockResolvedValue({});
    providerHasCredentials.mockReturnValue(false);

    const result = await ensureCrmRoutingAfterIntegrations();
    expect(result.applied).toBe('noop');
    expect(prismaMock.setting.upsert).not.toHaveBeenCalled();
  });
});

describe('getCrmRouting cache', () => {
  it('loads from prisma', async () => {
    invalidateCrmRoutingCache();
    prismaMock.setting.findUnique.mockResolvedValue({
      value: localOnlyCrmRouting(),
    });
    const r = await getCrmRouting({ fresh: true });
    expect(r.default).toBe('none');
  });
});
