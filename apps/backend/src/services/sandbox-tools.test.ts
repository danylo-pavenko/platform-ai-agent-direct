import { describe, expect, it, vi } from 'vitest';

vi.mock('./service-search.js', () => ({
  searchServicesForContext: vi.fn(async () => ({
    matchCount: 1,
    contextBlock: '[service_id=1] Чоловічий манікюр | 60 хв | від 500 ₴',
  })),
  getAvailableSlotsForContext: vi.fn(async () =>
    [
      '## 05.08.2026',
      '- 13:00 | майстри: [master_id=m1] Оля',
      '',
      'Для book_appointment використовуй master_id з цього списку.',
    ].join('\n'),
  ),
}));

vi.mock('./product-search.js', () => ({
  searchActiveProductsForContext: vi.fn(async () => ({
    matchCount: 1,
    contextBlock: '[product_id=9] Худі | 1200 ₴',
  })),
}));

vi.mock('./nova-poshta.js', () => ({
  getDeliveryCost: vi.fn(async () => ({ cost: 80, city: 'Львів' })),
}));

vi.mock('./booking-branch.js', () => ({
  resolveBookingBranchCrmId: vi.fn(async () => 'loc-1'),
}));

import {
  buildReturningPersonaHistory,
  executeSandboxToolCall,
  pickSandboxToolCall,
} from './sandbox-tools.js';

describe('sandbox tools', () => {
  it('prioritizes search_catalog / search_services before slots', () => {
    const picked = pickSandboxToolCall([
      { name: 'get_available_slots', args: { date: '05.08.2026' } },
      { name: 'search_services', args: { query: 'манікюр' } },
      { name: 'search_catalog', args: { query: 'худі' } },
    ]);
    expect(picked?.name).toBe('search_catalog');
  });

  it('runs search_services and search_catalog against live adapters', async () => {
    const services = await executeSandboxToolCall({
      name: 'search_services',
      args: { query: 'чоловічий манікюр' },
    });
    expect(services.content).toContain('[search_services] РЕЗУЛЬТАТ:');

    const catalog = await executeSandboxToolCall({
      name: 'search_catalog',
      args: { query: 'худі' },
    });
    expect(catalog.content).toContain('[search_catalog] РЕЗУЛЬТАТ:');
    expect(catalog.content).toContain('Худі');
  });

  it('runs get_available_slots with master ids', async () => {
    const result = await executeSandboxToolCall({
      name: 'get_available_slots',
      args: {
        date: '05.08.2026',
        services: [{ id: '1', duration_min: 60 }],
      },
    });
    expect(result.content).toContain('[master_id=m1] Оля');
  });

  it('dry-runs book_appointment and collect_order with payload preview', async () => {
    const book = await executeSandboxToolCall({
      name: 'book_appointment',
      args: { customer_name: 'Данило', phone: '380958959421' },
    });
    expect(book.dryRun).toBe(true);
    expect(book.content).toMatch(/DRY-RUN/i);
    expect(book.content).toContain('Данило');

    const order = await executeSandboxToolCall({
      name: 'collect_order',
      args: { summary: 'тест' },
    });
    expect(order.dryRun).toBe(true);
    expect(order.content).toContain('Payload preview');
  });

  it('builds returning persona history with preferred master id', () => {
    const text = buildReturningPersonaHistory();
    expect(text).toContain('[master_id=sandbox-master-olya]');
    expect(text).toContain('Улюблений майстер');
  });
});
