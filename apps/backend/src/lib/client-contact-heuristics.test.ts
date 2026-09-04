import { describe, expect, it } from 'vitest';
import {
  extractContactPatchesFromText,
  extractPersonNameFromText,
  normalizeUaPhone,
} from './client-contact-heuristics.js';

describe('extractPersonNameFromText', () => {
  it('accepts a two-word capitalized Ukrainian name', () => {
    expect(extractPersonNameFromText('Тимофіїв Анжела')).toBe('Тимофіїв Анжела');
  });

  it('rejects greetings, services and mixed sentences', () => {
    expect(extractPersonNameFromText('Доброго дня')).toBeUndefined();
    expect(extractPersonNameFromText('Манікюр Комплекс')).toBeUndefined();
    expect(extractPersonNameFromText('Хочу записатись')).toBeUndefined();
  });
});

describe('extractContactPatchesFromText', () => {
  it('extracts a Ukrainian mobile from a phone-only bubble', () => {
    expect(extractContactPatchesFromText('0930152179').phone).toBe('+380930152179');
  });

  it('extracts ПІБ from a name-only bubble', () => {
    expect(extractContactPatchesFromText('Тимофіїв Анжела').displayName).toBe(
      'Тимофіїв Анжела',
    );
  });

  it('does not treat a phone bubble as a name', () => {
    expect(extractContactPatchesFromText('0930152179').displayName).toBeUndefined();
  });
});

describe('normalizeUaPhone', () => {
  it('normalizes 0XX to +380', () => {
    expect(normalizeUaPhone('0930152179')).toBe('+380930152179');
  });
});
