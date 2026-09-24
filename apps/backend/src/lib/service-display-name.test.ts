import { describe, expect, it } from 'vitest';
import {
  buildServiceNameCatalog,
  looksLikePlaceholderServiceName,
  looksLikeServiceIdLeakInText,
  resolveServiceDisplayName,
} from './service-display-name.js';
import { buildBookingConfirmationText } from './booking-confirmation.js';
import {
  formatUpcomingVisitsForPrompt,
  selectUpcomingVisits,
  uaDateSortKey,
} from './upcoming-visit.js';

describe('service-display-name', () => {
  const id = '88d8645d-1ff5-14f5-6d46-f6ed2a32f099';
  const catalog = buildServiceNameCatalog([{ id, name: 'Денний макіяж' }]);

  it('detects placeholder / UUID names', () => {
    expect(looksLikePlaceholderServiceName(undefined, id)).toBe(true);
    expect(looksLikePlaceholderServiceName(`Послуга #${id}`, id)).toBe(true);
    expect(looksLikePlaceholderServiceName(id, id)).toBe(true);
    expect(looksLikePlaceholderServiceName('Денний макіяж', id)).toBe(false);
  });

  it('resolves from catalog', () => {
    expect(resolveServiceDisplayName(undefined, id, catalog)).toBe('Денний макіяж');
    expect(resolveServiceDisplayName(`Послуга #${id}`, id, catalog)).toBe('Денний макіяж');
    expect(resolveServiceDisplayName('Денний макіяж', id, catalog)).toBe('Денний макіяж');
  });

  it('falls back to Послуга when catalog miss', () => {
    expect(resolveServiceDisplayName(undefined, 'missing-id', catalog)).toBe('Послуга');
  });

  it('detects UUID leak in customer text', () => {
    expect(
      looksLikeServiceIdLeakInText(
        `Запис підтверджено\n• Послуга #${id} — 10:30\nЧекаємо`,
      ),
    ).toBe(true);
    expect(looksLikeServiceIdLeakInText('Запис підтверджено на денний макіяж о 10:30')).toBe(
      false,
    );
  });
});

describe('buildBookingConfirmationText + name scrub', () => {
  const id = '88d8645d-1ff5-14f5-6d46-f6ed2a32f099';

  it('never emits Послуга #uuid when building structured text', () => {
    const text = buildBookingConfirmationText({
      date: '26.09.2026',
      time: '10:30',
      services: [{ name: `Послуга #${id}`, startTime: '10:30' }],
    });
    expect(text).toContain('• Послуга — 10:30');
    expect(text).not.toContain(id);
  });

  it('rebuilds when Claude firm confirm leaks a UUID', () => {
    const text = buildBookingConfirmationText({
      date: '26.09.2026',
      time: '10:30',
      clientMessage: `Запис підтверджено на 26.09.2026:\n• Послуга #${id} — 10:30\nЧекаємо на вас!`,
      services: [{ name: 'Денний макіяж', startTime: '10:30' }],
    });
    expect(text).toContain('Денний макіяж — 10:30');
    expect(text).not.toContain(id);
  });
});

describe('upcoming-visit', () => {
  it('selects today and near-future visits', () => {
    // 2026-09-24 12:00 UTC ≈ afternoon in Europe/Kyiv
    const now = new Date('2026-09-24T09:00:00.000Z');
    const rows = [
      {
        scheduledDate: '23.09.2026',
        scheduledTime: '10:00',
        services: [{ name: 'yesterday' }],
      },
      {
        scheduledDate: '24.09.2026',
        scheduledTime: '09:50',
        services: [{ id: 'x', name: 'Комплекс манікюр' }],
      },
      {
        scheduledDate: '26.09.2026',
        scheduledTime: '11:00',
        services: [{ name: 'Брови' }],
      },
      {
        scheduledDate: '30.09.2026',
        scheduledTime: '12:00',
        services: [{ name: 'too far' }],
      },
    ];
    const picked = selectUpcomingVisits(rows, now, 'Europe/Kyiv', {
      horizonDays: 3,
      limit: 3,
    });
    expect(picked.map((p) => p.scheduledDate)).toEqual(['24.09.2026', '26.09.2026']);
    expect(uaDateSortKey('24.09.2026')).toBe(20260924);
  });

  it('formats lateness rule for prompt', () => {
    const block = formatUpcomingVisitsForPrompt([
      {
        scheduledDate: '24.09.2026',
        scheduledTime: '09:50',
        services: [{ name: 'Комплекс манікюр' }],
      },
    ]);
    expect(block).toContain('Найближчі записи');
    expect(block).toContain('Комплекс манікюр');
    expect(block).toMatch(/запізнюється/i);
    expect(block).toMatch(/НЕ новий запис/);
  });
});
