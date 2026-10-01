import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    setting: { findUnique: vi.fn() },
  },
}));

vi.mock('../config.js', () => ({
  config: { NOVA_POSHTA_API_KEY: '' },
}));

import { prisma } from '../lib/prisma.js';
import { testNovaPoshtaConnection } from './nova-poshta.js';

const findSetting = vi.mocked(prisma.setting.findUnique);

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('testNovaPoshtaConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('asks for a key when nothing is saved', async () => {
    findSetting.mockResolvedValue(null as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await testNovaPoshtaConnection({ apiKey: '••••••' });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a key when Nova Poshta returns cargo types', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: [{ Description: 'Вантаж' }],
        errors: [],
        warnings: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await testNovaPoshtaConnection({ apiKey: 'np-test-key' });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Підключено/);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.apiKey).toBe('np-test-key');
    expect(body.modelName).toBe('Common');
    expect(body.calledMethod).toBe('getCargoTypes');
  });

  it('does not echo a rejected key', async () => {
    const secret = 'super-secret-np-key-123456';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: false,
        data: [],
        errors: [`API key incorrect ${secret}`],
        warnings: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await testNovaPoshtaConnection({ apiKey: secret });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/відхилила/);
    expect(result.message).not.toContain(secret);
  });
});
