import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    BRAND_NAME: 'Test',
    TENANT_KNOWLEDGE_DIR: '/tmp',
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {},
}));

vi.mock('../../lib/crm-routing.js', () => ({
  resolveCrmProvider: vi.fn(),
}));

vi.mock('../../lib/integration-config.js', () => ({
  getIntegrationConfig: vi.fn(),
}));

import { formatCrmHistoryForPrompt, formatCrmLinkHintForPrompt } from '../client-crm-link.js';
import { formatSlotMastersLine } from '../service-search.js';

describe('formatCrmLinkHintForPrompt', () => {
  it('points at get_client_crm_history without dumping visits', () => {
    const text = formatCrmLinkHintForPrompt({ crmBuyerId: 'abc-def-12345678' });
    expect(text).toMatch(/get_client_crm_history/);
    expect(text).not.toMatch(/хв \|/);
  });

  it('includes preferred master when provided', () => {
    const text = formatCrmLinkHintForPrompt({
      crmBuyerId: 'id',
      preferredMasterId: 'pro-1',
      preferredMasterName: 'Анна',
    });
    expect(text).toContain('[master_id=pro-1]');
    expect(text).toContain('Анна');
    expect(text).toMatch(/схожої послуги|Інша категорія/i);
  });
});

describe('formatCrmHistoryForPrompt', () => {
  it('includes master_id for tools and a preferred-master hint', () => {
    const text = formatCrmHistoryForPrompt([
      {
        id: 'v1',
        date: '2026-07-01T10:00:00.000Z',
        durationMin: 60,
        professionalId: 'pro-uuid-1',
        professionalName: 'Анна',
        items: [{ name: 'Стрижка', type: 'Service' }],
      },
    ]);

    expect(text).toContain('[master_id=pro-uuid-1]');
    expect(text).toContain('майстер: Анна');
    expect(text).toContain('Улюблений майстер');
    expect(text).toMatch(/лише для схожої послуги/i);
    expect(text).toContain('get_available_slots');
  });

  it('omits master_id when only the name is present', () => {
    const text = formatCrmHistoryForPrompt([
      {
        id: 'v2',
        date: '2026-07-01T10:00:00.000Z',
        durationMin: 45,
        professionalName: 'Богдан',
        items: [{ name: 'Фарбування', type: 'Service' }],
      },
    ]);

    expect(text).toContain('майстер: Богдан');
    expect(text).not.toContain('[master_id=');
    expect(text).not.toContain('Улюблений майстер');
  });

  it('still emits master_id when only professionalId is present', () => {
    const text = formatCrmHistoryForPrompt([
      {
        id: 'v3',
        date: '2026-07-02T10:00:00.000Z',
        durationMin: 30,
        professionalId: 'only-id',
        items: [{ name: 'Манікюр', type: 'Service' }],
      },
    ]);

    expect(text).toContain('[master_id=only-id]');
    expect(text).toContain('Улюблений майстер');
  });

  it('uses the newest visit with a professionalId for the preferred hint', () => {
    const text = formatCrmHistoryForPrompt([
      {
        id: 'newer',
        date: '2026-07-10T10:00:00.000Z',
        durationMin: 40,
        professionalId: 'new-pro',
        professionalName: 'Новий',
        items: [{ name: 'Стрижка', type: 'Service' }],
      },
      {
        id: 'older',
        date: '2026-06-01T10:00:00.000Z',
        durationMin: 40,
        professionalId: 'old-pro',
        professionalName: 'Старий',
        items: [{ name: 'Стрижка', type: 'Service' }],
      },
    ]);

    expect(text).toContain('Новий [master_id=new-pro]');
    expect(text).toMatch(/лише для схожої послуги/i);
    expect(text).toMatch(/Улюблений майстер \(лише для схожої послуги: Стрижка\): Новий/);
    expect(text).not.toMatch(/Улюблений майстер[^]*Старий/);
  });
});

describe('formatSlotMastersLine', () => {
  it('formats master ids for book_appointment', () => {
    const map = new Map([
      ['id-a', 'Anna'],
      ['id-b', 'Bohdan'],
    ]);
    expect(formatSlotMastersLine(['id-a', 'id-b'], map)).toBe(
      '[master_id=id-a] Anna, [master_id=id-b] Bohdan',
    );
  });

  it('falls back to raw id when name is unknown', () => {
    expect(formatSlotMastersLine(['x'], new Map())).toBe('[master_id=x] x');
  });
});
