import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, resolveCrmProvider, getIntegrationConfig, config } = vi.hoisted(() => ({
  prismaMock: { setting: { findUnique: vi.fn() } },
  resolveCrmProvider: vi.fn(),
  getIntegrationConfig: vi.fn(),
  config: { CRM_WRITE_ENABLED: false },
}));

vi.mock('../config.js', () => ({ config }));
vi.mock('./prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('./crm-routing.js', () => ({ resolveCrmProvider }));
vi.mock('./integration-config.js', () => ({ getIntegrationConfig }));

import {
  invalidateCrmWriteCache,
  isCrmWriteReady,
  providerWriteCredentialsReason,
} from './crm-write.js';

const emptyCreds = {
  keycrm: { apiKey: '', syncIntervalMin: 30, defaultSourceId: 1, appUrl: '' },
  cleverbox: { apiToken: '', defaultBranchId: '', syncIntervalMin: 30 },
  beautypro: {
    applicationId: '',
    applicationSecret: '',
    databaseCode: '',
    defaultLocationId: '',
    syncIntervalMin: 30,
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: '',
    apiServer: 1,
    authStatus: '' as const,
  },
};

describe('providerWriteCredentialsReason', () => {
  it('requires KeyCRM api key', () => {
    expect(providerWriteCredentialsReason('keycrm', emptyCreds)).toMatch(/KeyCRM/);
    expect(
      providerWriteCredentialsReason('keycrm', {
        ...emptyCreds,
        keycrm: { ...emptyCreds.keycrm, apiKey: 'k' },
      }),
    ).toBeNull();
  });

  it('requires CleverBOX token', () => {
    expect(providerWriteCredentialsReason('cleverbox', emptyCreds)).toMatch(/CleverBOX/);
    expect(
      providerWriteCredentialsReason('cleverbox', {
        ...emptyCreds,
        cleverbox: { ...emptyCreds.cleverbox, apiToken: 't' },
      }),
    ).toBeNull();
  });

  it('requires BeautyPro app credentials and Marketplace grant', () => {
    expect(providerWriteCredentialsReason('beautypro', emptyCreds)).toMatch(/BeautyPro/);
    const granted = {
      ...emptyCreds,
      beautypro: {
        ...emptyCreds.beautypro,
        applicationId: 'app',
        applicationSecret: 'secret',
        databaseCode: 'db',
        authStatus: 'granted' as const,
      },
    };
    expect(providerWriteCredentialsReason('beautypro', granted)).toBeNull();

    expect(
      providerWriteCredentialsReason('beautypro', {
        ...granted,
        beautypro: { ...granted.beautypro, authStatus: 'pending' },
      }),
    ).toMatch(/Marketplace/);

    expect(
      providerWriteCredentialsReason('beautypro', {
        ...granted,
        beautypro: { ...granted.beautypro, authStatus: 'refused' },
      }),
    ).toMatch(/відхилено/);
  });
});

describe('isCrmWriteReady', () => {
  beforeEach(() => {
    invalidateCrmWriteCache();
    config.CRM_WRITE_ENABLED = false;
    vi.clearAllMocks();
  });

  it('is not ready when writes are disabled', async () => {
    prismaMock.setting.findUnique.mockResolvedValue({ value: {} });
    resolveCrmProvider.mockResolvedValue('beautypro');
    const result = await isCrmWriteReady('booking');
    expect(result.ready).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.provider).toBe('beautypro');
    expect(result.reason).toMatch(/вимкнено/);
  });

  it('checks BeautyPro credentials for booking, not KeyCRM', async () => {
    config.CRM_WRITE_ENABLED = true;
    resolveCrmProvider.mockResolvedValue('beautypro');
    getIntegrationConfig.mockResolvedValue({
      ...emptyCreds,
      beautypro: {
        ...emptyCreds.beautypro,
        applicationId: 'app',
        applicationSecret: 'secret',
        databaseCode: 'db',
        authStatus: 'granted',
      },
    });

    const result = await isCrmWriteReady('booking');
    expect(resolveCrmProvider).toHaveBeenCalledWith('booking');
    expect(result.ready).toBe(true);
    expect(result.provider).toBe('beautypro');
  });

  it('fails order write-ready without a KeyCRM key even if BeautyPro is set', async () => {
    config.CRM_WRITE_ENABLED = true;
    resolveCrmProvider.mockResolvedValue('keycrm');
    getIntegrationConfig.mockResolvedValue({
      ...emptyCreds,
      beautypro: {
        ...emptyCreds.beautypro,
        applicationId: 'app',
        applicationSecret: 'secret',
        databaseCode: 'db',
        authStatus: 'granted',
      },
    });

    const result = await isCrmWriteReady('order');
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/KeyCRM/);
  });
});
