import { describe, expect, it } from 'vitest';
import {
  buildMetaPromptContext,
  buildSectionToc,
  selectRelevantSections,
  splitPromptSections,
} from './prompt-sections.js';

const SAMPLE = `Intro line

═══ TONE OF VOICE ═══

Be warm and friendly.

═══ ПРАВИЛА ДОСТАВКИ ═══

Нова Пошта від 50 грн. Безкоштовна доставка від 2000 грн.

═══ ЕСКАЛАЦІЯ ═══

Передай менеджеру при скаргах.
`;

describe('splitPromptSections', () => {
  it('splits on ═══ markers', () => {
    const sections = splitPromptSections(SAMPLE);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.map((s) => s.title)).toEqual(
      expect.arrayContaining(['TONE OF VOICE', 'ПРАВИЛА ДОСТАВКИ', 'ЕСКАЛАЦІЯ']),
    );
  });

  it('splits markdown headers', () => {
    const md = `# Booking\n\nHello\n\n## Branches\n\nA\n\n## Flow\n\nB`;
    const sections = splitPromptSections(md);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0].title).toMatch(/Booking/i);
  });
});

describe('selectRelevantSections', () => {
  it('prefers delivery section for delivery query', () => {
    const sections = splitPromptSections(SAMPLE);
    const selected = selectRelevantSections('додай безкоштовну доставку від 2000', sections, 2);
    expect(selected.some((s) => /доставк/i.test(s.title))).toBe(true);
  });
});

describe('buildMetaPromptContext', () => {
  it('returns lean TOC+sections for multi-section prompts', () => {
    const ctx = buildMetaPromptContext(SAMPLE, 'зміни правила ескалації до менеджера');
    expect(ctx.sectionCount).toBeGreaterThanOrEqual(3);
    if (!ctx.usedFullPrompt) {
      expect(ctx.promptBlock).toContain('<prompt_toc>');
      expect(ctx.promptBlock).toContain('<selected_sections>');
    }
  });

  it('buildSectionToc lists ids', () => {
    const toc = buildSectionToc(splitPromptSections(SAMPLE));
    expect(toc).toContain('TONE OF VOICE');
  });
});
