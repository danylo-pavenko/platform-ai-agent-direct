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
}));

import { executeLookupTool, lookupResultFromResponse } from './agent-lookup-tools.js';
import { searchActiveProductsForContext } from './product-search.js';
import { searchServicesWithFallback } from './booking-lookup.js';
import { fetchClientCrmHistory } from './client-crm-link.js';

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
