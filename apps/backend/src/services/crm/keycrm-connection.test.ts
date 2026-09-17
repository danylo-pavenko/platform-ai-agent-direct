import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/integration-config.js', () => ({
  getIntegrationConfig: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    KEYCRM_LEAD_PIPELINE_ID: 0,
  },
}));

import { getIntegrationConfig } from '../../lib/integration-config.js';
import { testKeycrmConnection } from './keycrm.js';

const getIntegrationConfigMock = vi.mocked(getIntegrationConfig);

describe('testKeycrmConnection', () => {
  beforeEach(() => {
    getIntegrationConfigMock.mockResolvedValue({
      keycrm: {
        apiKey: 'saved-key',
        syncIntervalMin: 60,
        defaultSourceId: 1,
        appUrl: '',
      },
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fails when no api key', async () => {
    getIntegrationConfigMock.mockResolvedValue({
      keycrm: { apiKey: '', syncIntervalMin: 60, defaultSourceId: 1, appUrl: '' },
    } as never);
    const result = await testKeycrmConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/API Key/i);
  });

  it('uses override key and returns product preview on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          total: 12,
          data: [{ id: 1, name: 'Serum' }],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testKeycrmConnection({ apiKey: 'form-key' });
    expect(result.ok).toBe(true);
    expect(result.productTotal).toBe(12);
    expect(result.productsPreview?.[0]?.name).toBe('Serum');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/products');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer form-key',
    });
  });

  it('maps 401 to Ukrainian error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '{"message":"Unauthorized"}',
      }),
    );
    const result = await testKeycrmConnection({ apiKey: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/401\/403|API Key/);
  });

  it('ignores masked override and uses saved key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ total: 0, data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await testKeycrmConnection({ apiKey: '••••••' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer saved-key',
    );
  });
});
