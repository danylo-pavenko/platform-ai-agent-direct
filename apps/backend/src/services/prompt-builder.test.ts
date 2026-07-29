import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BRAND_NAME: 'Test Brand',
    TENANT_KNOWLEDGE_DIR: '/tmp/tenant_knowledge_test',
  },
}));

vi.mock('../lib/paths.js', () => ({
  getCatalogPath: () => '/tmp/catalog.txt',
  getTenantKnowledgeDir: () => '/tmp/tenant_knowledge_test',
}));

import {
  buildRuntimePrompt,
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
    expect(prompt).toMatch(/Товари \/ ціни \/ наявність — з каталогу нижче або через tools/);
  });

  it('keeps anti-injection preamble with source hierarchy', () => {
    const prompt = buildRuntimePrompt(baseParams());
    expect(prompt).toMatch(/prompt injection/i);
    expect(prompt).toMatch(/активний системний промпт = бренд, контакти/);
    expect(prompt).toMatch(/живий каталог \+ tools/);
  });
});
