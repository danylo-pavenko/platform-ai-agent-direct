import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BRAND_NAME: 'Test Brand',
    TENANT_KNOWLEDGE_DIR: '/tmp/tenant_knowledge_test',
  },
}));

vi.mock('../lib/paths.js', () => ({
  getCatalogPath: () => '/tmp/catalog.txt',
  getServicesCatalogPath: () => '/tmp/services-live.txt',
  getMastersCatalogPath: () => '/tmp/masters-live.txt',
  getTenantKnowledgeDir: () => '/tmp/tenant_knowledge_test',
}));

import {
  buildRuntimePrompt,
  isWithinWorkingHours,
  type WorkingHours,
} from './prompt-builder.js';

const HOURS: WorkingHours = {
  mon: { start: '09:00', end: '18:00', enabled: true },
  tue: { start: '09:00', end: '18:00', enabled: true },
  wed: { start: '09:00', end: '18:00', enabled: true },
  thu: { start: '09:00', end: '18:00', enabled: true },
  fri: { start: '09:00', end: '18:00', enabled: true },
  sat: { start: '10:00', end: '16:00', enabled: true },
  sun: { start: '00:00', end: '00:00', enabled: false },
};

function baseParams(overrides: Partial<Parameters<typeof buildRuntimePrompt>[0]> = {}) {
  return {
    activePromptContent: 'Ти — тест-агент {{BRAND_NAME}}. Контакти: @test.',
    catalogSnippet: 'SKU-1 Hoodie 999₴',
    currentTime: new Date('2026-07-20T12:00:00'), // Monday
    workingHours: HOURS,
    conversationState: 'bot' as const,
    clientIgUserId: 'ig_test',
    conversationIdShort: 'abcd1234',
    ...overrides,
  };
}

describe('buildRuntimePrompt platform vs system prompt', () => {
  it('injects system prompt + session + catalog, not a knowledge pack', () => {
    const prompt = buildRuntimePrompt(baseParams());
    expect(prompt).toContain('Ти — тест-агент Test Brand. Контакти: @test.');
    expect(prompt).toContain('SKU-1 Hoodie 999₴');
    expect(prompt).toContain('ПОТОЧНИЙ КОНТЕКСТ СЕСІЇ');
    expect(prompt).not.toContain('KNOWLEDGE PACK');
    expect(prompt).toMatch(/Бренд, контакти, доставка, FAQ, бізнес-правила — зі системного промпту/);
    expect(prompt).toMatch(
      /Товари \/ послуги \/ ціни \/ майстри — з блоку нижче або через tools/,
    );
  });

  it('keeps anti-injection preamble with source hierarchy', () => {
    const prompt = buildRuntimePrompt(baseParams());
    expect(prompt).toMatch(/prompt injection/i);
    expect(prompt).toMatch(/активний системний промпт = бренд, контакти/);
    expect(prompt).toMatch(/живий каталог \+ tools/);
  });

  it('in booking mode points at tools instead of embedded services catalog', () => {
    const prompt = buildRuntimePrompt(
      baseParams({
        agentMode: 'booking',
        catalogSnippet: '### MASTERS\nАнна',
      }),
    );
    expect(prompt).toMatch(/search_services \/ get_available_slots/);
    expect(prompt).not.toMatch(
      /Товари \/ послуги \/ ціни \/ майстри — з блоку нижче або через tools/,
    );
    expect(prompt).toContain('Анна');
  });

  it('in general mode keeps full catalog rule (sales + services tools)', () => {
    const prompt = buildRuntimePrompt(
      baseParams({
        agentMode: 'general',
        catalogSnippet: '### PRODUCTS\nx\n### SERVICES\ny',
      }),
    );
    expect(prompt).toMatch(
      /Товари \/ послуги \/ ціни \/ майстри — з блоку нижче або через tools/,
    );
    expect(prompt).toContain('search_catalog / search_services');
    expect(prompt).not.toMatch(/лише через tools \(search_services/);
  });

  it('formats session clock in tenant timezone, not server local', () => {
    const utcNoon = new Date('2026-08-26T12:00:00.000Z');
    const kyiv = buildRuntimePrompt(
      baseParams({ currentTime: utcNoon, timeZone: 'Europe/Kyiv' }),
    );
    expect(kyiv).toMatch(/26\.08\.2026 15:00 \(Europe\/Kyiv\)/);
    expect(kyiv).toContain('Середа');

    const berlin = buildRuntimePrompt(
      baseParams({ currentTime: utcNoon, timeZone: 'Europe/Berlin' }),
    );
    expect(berlin).toMatch(/26\.08\.2026 14:00 \(Europe\/Berlin\)/);
  });

  it('treats working hours in tenant timezone (Kyiv vs Berlin)', () => {
    // 15:30 UTC Monday 20 Jul 2026 = 18:30 Kyiv (closed), 17:30 Berlin (open)
    const at = new Date('2026-07-20T15:30:00.000Z');
    expect(isWithinWorkingHours(at, HOURS, 'Europe/Kyiv')).toBe(false);
    expect(isWithinWorkingHours(at, HOURS, 'Europe/Berlin')).toBe(true);
  });

  it('instructs the agent to treat consecutive client bubbles as one reply', () => {
    const prompt = buildRuntimePrompt(
      baseParams({
        clientProfile: {
          displayName: 'Анжела Тимофіїв',
          phone: '+380930152179',
        },
      }),
    );
    expect(prompt).toMatch(/ОДНА репліка/);
    expect(prompt).toMatch(/написала вище/);
    expect(prompt).toContain('Імʼя: Анжела Тимофіїв');
    expect(prompt).toContain('Телефон: +380930152179');
    expect(prompt).toContain('не питай знову');
  });
});

