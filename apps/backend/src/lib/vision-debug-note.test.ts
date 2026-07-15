import { describe, expect, it } from 'vitest';
import {
  extractVisionInterpretation,
  formatVisionDebugNote,
} from './vision-debug-note.js';

describe('extractVisionInterpretation', () => {
  it('returns trimmed short text', () => {
    expect(extractVisionInterpretation('  Футболка I DON\'T PANIC  ')).toBe(
      "Футболка I DON'T PANIC",
    );
  });

  it('strips tool_call blocks', () => {
    const text =
      'Бачу футболку <tool_call>{"name":"search_catalog"}</tool_call> зараз пошукаю';
    expect(extractVisionInterpretation(text)).toBe('Бачу футболку зараз пошукаю');
  });
});

describe('formatVisionDebugNote', () => {
  it('formats vision + catalog hit', () => {
    const note = formatVisionDebugNote({
      imageCount: 1,
      interpretation: 'Футболка I DON\'T PANIC, ~1050₴',
      catalog: {
        query: "I DON'T PANIC",
        matchCount: 2,
        contextBlock: '• Футболка I DON\'T PANIC — від 1050₴\n• Худі — від 1800₴\nproduct_id: 1',
        source: 'search_catalog',
      },
    });

    expect(note).toContain('🔍 Аналіз зображення');
    expect(note).toContain('опрацьовано 1 зображення');
    expect(note).toContain('Інтерпретація: Футболка');
    expect(note).toContain('знайдено 2');
    expect(note).toContain('Футболка I DON\'T PANIC');
    expect(note).not.toContain('product_id');
  });

  it('formats no-catalog case', () => {
    const note = formatVisionDebugNote({ imageCount: 2, interpretation: null });
    expect(note).toContain('2 зображень');
    expect(note).toContain('пошук не виконували');
  });
});
