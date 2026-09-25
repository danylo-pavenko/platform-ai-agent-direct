import { describe, expect, it, vi } from 'vitest';

vi.mock('./product-search.js', () => ({
  searchActiveProductsForContext: vi.fn(),
}));
vi.mock('./nova-poshta.js', () => ({
  getDeliveryCost: vi.fn(),
}));
vi.mock('./booking-lookup.js', () => ({
  executeGetAvailableSlotsTool: vi.fn(),
  formatSearchServicesToolResult: vi.fn(
    (p: { query: string; matchCount: number }) =>
      p.matchCount === 0
        ? `[search_services] Нічого не знайдено за «${p.query}».`
        : `[search_services] РЕЗУЛЬТАТ (${p.matchCount})`,
  ),
  parseSearchServicesLimit: vi.fn(() => 12),
  searchServicesWithFallback: vi.fn(),
}));
vi.mock('./client-crm-link.js', () => ({
  fetchClientCrmHistory: vi.fn(),
  lookupClientByPhone: vi.fn(),
}));

import { executeLookupTool, lookupResultFromResponse } from './agent-lookup-tools.js';
import { searchActiveProductsForContext } from './product-search.js';
import { searchServicesWithFallback } from './booking-lookup.js';
import { fetchClientCrmHistory, lookupClientByPhone } from './client-crm-link.js';

describe('executeLookupTool', () => {
  it('rejects empty search_services query', async () => {
    await expect(executeLookupTool('search_services', { query: '  ' })).resolves.toBe(
      '[search_services] ПОМИЛКА: порожній запит',
    );
    expect(searchServicesWithFallback).not.toHaveBeenCalled();
  });

  it('does not invent a price when search_services is empty', async () => {
    vi.mocked(searchServicesWithFallback).mockResolvedValueOnce({
      contextBlock: '',
      matchCount: 0,
      usedQuery: 'манікюр',
    });
    const text = await executeLookupTool('search_services', { query: 'манікюр' });
    expect(text).toContain('Нічого не знайдено');
    expect(text).not.toMatch(/\d+\s*₴/);
  });

  it('denies CRM history unless booking client is linked', async () => {
    const denied = await executeLookupTool(
      'get_client_crm_history',
      {},
      { clientId: 'c1', crmHistoryAllowed: false },
    );
    expect(denied).toMatch(/привʼязаного CRM-клієнта/);
    expect(fetchClientCrmHistory).not.toHaveBeenCalled();
  });

  it('loads CRM history when allowed', async () => {
    vi.mocked(fetchClientCrmHistory).mockResolvedValueOnce({
      text: '10.07.2026 | 60 хв | манікюр',
    } as never);
    const text = await executeLookupTool(
      'get_client_crm_history',
      { service_query: 'манікюр' },
      { clientId: 'c1', crmHistoryAllowed: true },
    );
    expect(text).toContain('РЕЗУЛЬТАТ');
    expect(text).toContain('манікюр');
  });

  it('requires phone for lookup_client_by_phone', async () => {
    await expect(
      executeLookupTool('lookup_client_by_phone', {}, { clientId: 'c1' }),
    ).resolves.toMatch(/phone обовʼязковий/);
    expect(lookupClientByPhone).not.toHaveBeenCalled();
  });

  it('requires clientId for lookup_client_by_phone', async () => {
    await expect(
      executeLookupTool('lookup_client_by_phone', { phone: '0938165670' }),
    ).resolves.toMatch(/немає клієнта/);
    expect(lookupClientByPhone).not.toHaveBeenCalled();
  });

  it('returns CRM name from lookup_client_by_phone without asking again', async () => {
    vi.mocked(lookupClientByPhone).mockResolvedValueOnce({
      found: true,
      crmBuyerId: 'crm-1',
      fullName: 'Марта',
      phone: '+380938165670',
      text: '[lookup_client_by_phone] РЕЗУЛЬТАТ: знайдено в CRM.\nІмʼя з CRM / профілю: Марта — використай як customer_name',
    });
    const text = await executeLookupTool(
      'lookup_client_by_phone',
      { phone: '0938165670' },
      { clientId: 'c1' },
    );
    expect(text).toContain('знайдено в CRM');
    expect(text).toContain('Марта');
    expect(lookupClientByPhone).toHaveBeenCalledWith('c1', '0938165670');
  });

  it('formats catalog misses without leaking ids', async () => {
    vi.mocked(searchActiveProductsForContext).mockResolvedValueOnce({
      contextBlock: '',
      matchCount: 0,
    });
    const text = await executeLookupTool('search_catalog', { query: 'худі' });
    expect(text).toContain('Нічого не знайдено');
    expect(text).not.toMatch(/product_id|uuid/i);
  });
});

describe('lookupResultFromResponse', () => {
  it('reuses MCP results so conversation does not hit CRM twice', () => {
    expect(
      lookupResultFromResponse(
        [{ name: 'search_services', result: '[search_services] РЕЗУЛЬТАТ:\n…' }],
        'search_services',
      ),
    ).toContain('РЕЗУЛЬТАТ');
    expect(lookupResultFromResponse([], 'search_services')).toBeUndefined();
  });
});
