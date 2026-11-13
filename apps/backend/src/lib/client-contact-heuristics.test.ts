import { describe, expect, it } from 'vitest';
import {
  extractContactPatchesFromText,
  extractPersonNameFromText,
  nameMatchMayAttachCard,
  normalizeUaPhone,
} from './client-contact-heuristics.js';

describe('nameMatchMayAttachCard', () => {
  it('does not attach another person who only shares a given name or a different phone', () => {
    expect(
      nameMatchMayAttachCard({
        localName: 'Христина',
        cardName: 'Христина Ковтун',
        cardPhone: '+380730839484',
      }),
    ).toBe(false);
    expect(
      nameMatchMayAttachCard({
        localName: 'Христина Ковтун',
        cardName: 'Ковтун Христина',
        localPhone: '380973323280',
        cardPhone: '+380730839484',
      }),
    ).toBe(false);
  });

  it('attaches the same full name and keeps a phone only when the card has that number', () => {
    expect(
      nameMatchMayAttachCard({
        localName: 'Христина Ковтун',
        cardName: 'Ковтун Христина',
      }),
    ).toBe(true);
    expect(
      nameMatchMayAttachCard({
        localName: 'Христина Ковтун',
        cardName: 'Христина Ковтун',
        localPhone: '380973323280',
        cardPhone: '+380973323280',
      }),
    ).toBe(true);
  });
});

describe('extractPersonNameFromText', () => {
  it('accepts a two-word capitalized Ukrainian name', () => {
    expect(extractPersonNameFromText('Тимофіїв Анжела')).toBe('Тимофіїв Анжела');
  });

  it('extracts a name from «мене звати …»', () => {
    expect(extractPersonNameFromText('Привіт, мене звати Діана')).toBe('Діана');
    expect(extractPersonNameFromText('Я Марія')).toBe('Марія');
  });

  it('does not treat an Instagram headline as a name', () => {
    expect(
      extractPersonNameFromText('Йога для вагітних і після пологів'),
    ).toBeUndefined();
  });

  it('rejects greetings, services and mixed sentences', () => {
    expect(extractPersonNameFromText('Доброго дня')).toBeUndefined();
    expect(extractPersonNameFromText('Манікюр Комплекс')).toBeUndefined();
    expect(extractPersonNameFromText('Хочу записатись')).toBeUndefined();
  });

  it('does not treat day+master slot replies as ПІБ', () => {
    expect(extractPersonNameFromText('Пт Анастасія')).toBeUndefined();
    expect(extractPersonNameFromText('Пт Анастесія')).toBeUndefined();
    expect(extractContactPatchesFromText('Пт Анастасія').displayName).toBeUndefined();
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
