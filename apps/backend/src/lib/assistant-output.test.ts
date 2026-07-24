import { describe, expect, it } from 'vitest';
import {
  looksLikeAssistantMetaReasoning,
  stripAssistantMetaReasoning,
} from './assistant-output.js';

describe('stripAssistantMetaReasoning', () => {
  it('strips the Moxito-style English preamble before Ukrainian reply', () => {
    const raw =
      'This is an Instagram DM from a customer of Moxito Beauty Studio, not a coding task. I should respond in character per the system prompt, in Ukrainian. Привіт! 👋 У нас працює салон краси.';
    expect(stripAssistantMetaReasoning(raw)).toBe(
      'Привіт! 👋 У нас працює салон краси.',
    );
  });

  it('strips a separate English paragraph', () => {
    const raw =
      'This is not a coding task. I should respond in character.\n\nДобрий день! Що шукаєте?';
    expect(stripAssistantMetaReasoning(raw)).toBe('Добрий день! Що шукаєте?');
  });

  it('leaves clean Ukrainian replies alone', () => {
    const raw = 'Привіт! У нас є худі та футболки. Що цікавить?';
    expect(stripAssistantMetaReasoning(raw)).toBe(raw);
  });

  it('leaves English product names inside a Ukrainian reply', () => {
    const raw = 'Так, модель Oversized Hoodie є в наявності у розмірі M.';
    expect(stripAssistantMetaReasoning(raw)).toBe(raw);
  });
});

describe('looksLikeAssistantMetaReasoning', () => {
  it('detects coding-persona markers', () => {
    expect(
      looksLikeAssistantMetaReasoning(
        'This is an Instagram DM, not a coding task. I should respond in Ukrainian.',
      ),
    ).toBe(true);
  });

  it('rejects normal customer copy', () => {
    expect(looksLikeAssistantMetaReasoning('Привіт! Хочу записатись.')).toBe(false);
  });
});
