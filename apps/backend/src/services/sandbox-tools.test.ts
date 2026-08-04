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
      '- 14:00 | майстри: [master_id=m1] Оля',
      '',
      'Для book_appointment використовуй master_id з цього списку.',
    ].join('\n'),
  ),
}));

vi.mock('./booking-branch.js', () => ({
  resolveBookingBranchCrmId: vi.fn(async () => 'loc-1'),
}));

import {
  executeSandboxToolCall,
  pickSandboxToolCall,
} from './sandbox-tools.js';

describe('sandbox tools', () => {
  it('prioritizes search_services before get_available_slots', () => {
    const picked = pickSandboxToolCall([
      { name: 'get_available_slots', args: { date: '05.08.2026' } },
      { name: 'search_services', args: { query: 'манікюр' } },
    ]);
    expect(picked?.name).toBe('search_services');
  });

  it('runs search_services against CRM in sandbox', async () => {
    const result = await executeSandboxToolCall({
      name: 'search_services',
      args: { query: 'чоловічий манікюр' },
    });
    expect(result).toContain('[search_services] РЕЗУЛЬТАТ:');
    expect(result).toContain('Чоловічий манікюр');
  });

  it('runs get_available_slots and returns master names for the agent', async () => {
    const result = await executeSandboxToolCall({
      name: 'get_available_slots',
      args: {
        date: '05.08.2026',
        services: [{ id: '1', duration_min: 60 }],
      },
    });
    expect(result).toContain('[get_available_slots] РЕЗУЛЬТАТ:');
    expect(result).toContain('[master_id=m1] Оля');
    expect(result).toContain('13:00');
  });

  it('does not create a real booking in sandbox', async () => {
    const result = await executeSandboxToolCall({
      name: 'book_appointment',
      args: { customer_name: 'Данило', phone: '380958959421' },
    });
    expect(result).toMatch(/НЕ створюється/i);
  });
});
