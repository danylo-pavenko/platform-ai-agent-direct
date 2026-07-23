import { describe, expect, it } from 'vitest';
import {
  applyDiffToContent,
  applyDiffsSequentially,
  findFragmentRange,
  normalizeForMatch,
  parseMetaAgentResponse,
} from './meta-agent-diff.js';

describe('normalizeForMatch / findFragmentRange', () => {
  it('collapses whitespace', () => {
    expect(normalizeForMatch('a  \n  b')).toBe('a b');
  });

  it('finds exact fragment', () => {
    const content = 'Hello\nWorld\nEnd';
    const range = findFragmentRange(content, 'World');
    expect(range).toEqual({ start: 6, end: 11 });
  });

  it('finds fuzzy whitespace match', () => {
    const content = 'Правило:\n  доставка безкоштовна\nкінець';
    const range = findFragmentRange(content, 'Правило: доставка безкоштовна');
    expect(range).not.toBeNull();
    const applied = applyDiffToContent(content, {
      before: 'Правило: доставка безкоштовна',
      after: 'Правило: доставка від 2000 грн безкоштовна',
      summary: 'test',
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.content).toContain('від 2000');
    }
  });
});

describe('applyDiffsSequentially', () => {
  it('applies multiple diffs on working content', () => {
    const content = 'AAA one\n\nBBB two\n\nCCC three';
    const result = applyDiffsSequentially(content, [
      { before: 'AAA one', after: 'AAA 1', summary: 'a' },
      { before: 'BBB two', after: 'BBB 2', summary: 'b' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('AAA 1');
      expect(result.content).toContain('BBB 2');
      expect(result.content).toContain('CCC three');
    }
  });
});

describe('parseMetaAgentResponse', () => {
  it('parses JSON fence', () => {
    const text = `Ось зміни:
\`\`\`json
{
  "reply": "Додав правило доставки",
  "diffs": [
    { "before": "old", "after": "new", "summary": "delivery" }
  ]
}
\`\`\``;
    const parsed = parseMetaAgentResponse(text);
    expect(parsed.format).toBe('json');
    expect(parsed.reply).toContain('доставки');
    expect(parsed.diffs).toHaveLength(1);
    expect(parsed.diffs[0].after).toBe('new');
  });

  it('falls back to legacy markers', () => {
    const text = `ПОЯСНЕННЯ: тест

ЗМІНА 1:
--- БУЛО ---
старий текст
--- СТАЛО ---
новий текст
`;
    const parsed = parseMetaAgentResponse(text);
    expect(parsed.format).toBe('legacy');
    expect(parsed.diffs).toHaveLength(1);
    expect(parsed.diffs[0].before).toBe('старий текст');
    expect(parsed.diffs[0].after).toBe('новий текст');
  });
});
