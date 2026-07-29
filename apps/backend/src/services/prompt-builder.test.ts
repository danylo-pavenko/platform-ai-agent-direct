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
  _truncateKnowledgeForTest,
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
    activePromptContent: 'Ти — тест-агент {{BRAND_NAME}}.',
    catalogSnippet: 'SKU-1 Hoodie 999₴',
    currentTime: new Date('2026-07-20T12:00:00'), // Monday
    workingHours: HOURS,
    conversationState: 'bot' as const,
    clientIgUserId: 'ig_test',
    conversationIdShort: 'abcd1234',
    ...overrides,
  };
}

describe('buildRuntimePrompt knowledge pack', () => {
  it('injects KNOWLEDGE PACK when knowledgePack is provided', () => {
    const prompt = buildRuntimePrompt(
      baseParams({
        knowledgePack: '── Brand ──\nName: Acme Shop\n── FAQ ──\nReturns: escalate',
      }),
    );
    expect(prompt).toContain('KNOWLEDGE PACK');
    expect(prompt).toContain('Name: Acme Shop');
    expect(prompt).toContain('Returns: escalate');
    expect(prompt).toContain('SKU-1 Hoodie 999₴');
    expect(prompt).toMatch(/Ідентичність \(ім'я агента \/ бренд \/ позиціонування\) — зі системного промпту/);
    expect(prompt).toMatch(/Факти про доставку\/оплату\/FAQ\/каталог — з KNOWLEDGE PACK/);
    expect(prompt).toContain('Test Brand');
  });

  it('shows empty knowledge placeholder when pack is missing', () => {
    const prompt = buildRuntimePrompt(baseParams({ knowledgePack: '' }));
    expect(prompt).toContain('KNOWLEDGE PACK');
    expect(prompt).toContain('(порожньо — заповніть knowledge/*.txt');
  });
});

describe('_truncateKnowledgeForTest', () => {
  it('caps a single file and the overall pack', () => {
    const huge = 'x'.repeat(5_000);
    const pack = _truncateKnowledgeForTest([
      { title: 'Brand', content: huge },
      { title: 'FAQ', content: 'short faq' },
    ]);
    expect(pack).toContain('── Brand ──');
    expect(pack.length).toBeLessThanOrEqual(8_000 + 50);
    // Per-file cap ~2500 → Brand body truncated with ...
    expect(pack).toContain('...');
  });
});
