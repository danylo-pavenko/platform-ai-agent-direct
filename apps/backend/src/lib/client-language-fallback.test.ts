import { describe, expect, it } from 'vitest';
import {
  clientLanguageTurns,
  currentClientLanguageOrdinal,
  detectClientLanguage,
  detectRequestedLanguage,
  languageFromOpeningTurns,
  languageToStore,
  normalizeClientLanguage,
} from './client-language.js';
import {
  countConsecutiveFallbacksFromCodes,
  CUSTOMER_FALLBACK_BUSY_EN,
  CUSTOMER_FALLBACK_TIMEOUT,
  CUSTOMER_FALLBACK_TIMEOUT_EN,
  resolveCustomerFallback,
  type FallbackMessages,
} from './agent-fallback.js';

const DEFAULTS: FallbackMessages = {
  busy: {
    uk: 'Дякуємо за повідомлення! Менеджер відпише трохи пізніше.',
    en: CUSTOMER_FALLBACK_BUSY_EN,
  },
  timeout: {
    uk: CUSTOMER_FALLBACK_TIMEOUT,
    en: CUSTOMER_FALLBACK_TIMEOUT_EN,
  },
};

describe('detectClientLanguage', () => {
  it('detects Ukrainian from distinctive letters', () => {
    expect(detectClientLanguage('Добрий день! Хочу записатись на манікюр')).toBe('uk');
  });

  it('detects Russian and does not treat every Cyrillic text as Ukrainian', () => {
    expect(detectClientLanguage('Я хочу прошить мотор')).toBe('ru');
    expect(detectClientLanguage('я хочу прошити авто')).toBe('uk');
    expect(detectClientLanguage('Напишите, пожалуйста, цену')).toBe('ru');
  });

  it('detects English from a sentence, not from a model code', () => {
    expect(detectClientLanguage('Hi! I want to book a manicure tomorrow')).toBe('en');
    expect(detectClientLanguage('F30 320i')).toBeNull();
  });

  it('does not let the Ukrainian join-preamble outvote Russian bubbles', () => {
    const joined =
      'Клієнт надіслав кілька повідомлень підряд — це ОДНА відповідь (читай суцільно, не як окремі репліки):\n1) Здесь\n2) Здравствуйте';
    expect(detectClientLanguage(joined)).toBe('ru');
    expect(detectClientLanguage('Здесь')).toBe('ru');
    expect(detectClientLanguage('Сколько будет стоит прошить ф10 БМВ')).toBe('ru');
    expect(detectClientLanguage('528i 3.0 литра бензин атмо')).toBe('ru');
  });

  it('returns null for a link, digits, emoji, or a model code', () => {
    expect(detectClientLanguage('👍')).toBeNull();
    expect(detectClientLanguage('ok')).toBeNull();
    expect(detectClientLanguage('2019 320')).toBeNull();
    expect(detectClientLanguage('https://flashex-tuning.com/the-engine-price')).toBeNull();
    expect(detectClientLanguage('F30 320i')).toBeNull();
  });
});

describe('client language bursts', () => {
  const opening = [
    { sender: 'client', text: 'Я хочу прошить мотор.', sharedPost: null },
    { sender: 'client', text: null, sharedPost: { postUrl: 'https://instagram.com/p/1' } },
    { sender: 'client', text: 'Я хочу прошить мотор.', sharedPost: null },
  ];

  it('counts a shared post and the repeated sentence as the first message', () => {
    expect(clientLanguageTurns(opening)).toEqual([
      'Я хочу прошить мотор.\nЯ хочу прошить мотор.',
    ]);
    expect(currentClientLanguageOrdinal(opening)).toBe(1);
    expect(languageFromOpeningTurns(clientLanguageTurns(opening))).toBe('ru');
    expect(
      languageToStore({
        stored: null,
        text: 'Я хочу прошить мотор. Я хочу прошить мотор.',
        inboundOrdinal: currentClientLanguageOrdinal(opening),
      }),
    ).toBe('ru');
  });

  it('still recovers Russian from that opening after later messages left the card empty', () => {
    const rows = [
      ...opening,
      { sender: 'bot', text: 'Добрый день.', sharedPost: null },
      { sender: 'client', text: 'Это где ваше гараж', sharedPost: null },
      { sender: 'bot', text: 'Адреси немає.', sharedPost: null },
      { sender: 'client', text: '528i', sharedPost: null },
    ];
    expect(currentClientLanguageOrdinal(rows)).toBe(3);
    expect(detectClientLanguage('Это где ваше гараж')).toBe('ru');
    expect(languageFromOpeningTurns(clientLanguageTurns(rows))).toBe('ru');
    expect(languageToStore({ stored: null, text: '528i', inboundOrdinal: 3 })).toBeNull();
  });

  it('does not invent a language when the first two bursts are unclear', () => {
    const rows = [
      { sender: 'client', text: 'ок', sharedPost: null },
      { sender: 'bot', text: 'Слухаю.', sharedPost: null },
      { sender: 'client', text: 'F30 320i', sharedPost: null },
      { sender: 'bot', text: 'Який двигун?', sharedPost: null },
      { sender: 'client', text: 'Я хочу прошить мотор', sharedPost: null },
    ];
    expect(currentClientLanguageOrdinal(rows)).toBe(3);
    expect(languageFromOpeningTurns(clientLanguageTurns(rows))).toBeNull();
  });
});

describe('languageToStore', () => {
  it('locks a clear language on the first or second message only', () => {
    expect(languageToStore({ stored: null, text: 'Я хочу прошить мотор', inboundOrdinal: 1 })).toBe('ru');
    expect(languageToStore({ stored: null, text: 'https://flashex-tuning.com', inboundOrdinal: 1 })).toBeNull();
    expect(languageToStore({ stored: null, text: 'я хочу прошити авто', inboundOrdinal: 2 })).toBe('uk');
    expect(languageToStore({ stored: null, text: 'я хочу прошити авто', inboundOrdinal: 3 })).toBeNull();
  });

  it('does not switch a locked language until the person asks', () => {
    expect(languageToStore({ stored: 'ru', text: 'Напишіть, будь ласка, ціну', inboundOrdinal: 2 })).toBeNull();
    expect(languageToStore({ stored: 'ru', text: 'ок', inboundOrdinal: 4 })).toBeNull();
    expect(languageToStore({ stored: 'ru', text: 'можна українською?', inboundOrdinal: 5 })).toBe('uk');
    expect(languageToStore({ stored: 'uk', text: 'давайте на русском', inboundOrdinal: 6 })).toBe('ru');
    expect(languageToStore({ stored: 'ru', text: 'speak english please', inboundOrdinal: 3 })).toBe('en');
  });
});

describe('detectRequestedLanguage', () => {
  it('ignores a sentence that is simply written in a language', () => {
    expect(detectRequestedLanguage('Я хочу прошить мотор')).toBeNull();
    expect(detectRequestedLanguage('я хочу прошити авто')).toBeNull();
  });
});
describe('normalizeClientLanguage', () => {
  it('accepts uk, ru and en', () => {
    expect(normalizeClientLanguage('uk')).toBe('uk');
    expect(normalizeClientLanguage('ru')).toBe('ru');
    expect(normalizeClientLanguage('en')).toBe('en');
    expect(normalizeClientLanguage('pl')).toBe('pl');
    expect(normalizeClientLanguage('es')).toBe('es');
    expect(normalizeClientLanguage('de')).toBe('de');
    expect(normalizeClientLanguage('fr')).toBeNull();
    expect(normalizeClientLanguage(null)).toBeNull();
  });
});

describe('resolveCustomerFallback', () => {
  it('uses defaults by language', () => {
    expect(resolveCustomerFallback('timeout', 'uk', DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT);
    expect(resolveCustomerFallback('timeout', 'en', DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT_EN);
    expect(resolveCustomerFallback('timeout', 'ru', DEFAULTS)).toContain('минуту');
    expect(resolveCustomerFallback('busy', 'en', DEFAULTS)).toBe(CUSTOMER_FALLBACK_BUSY_EN);
  });

  it('falls back to uk for unknown language', () => {
    expect(resolveCustomerFallback('timeout', 'fr', DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT);
    expect(resolveCustomerFallback('timeout', null, DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT);
  });

  it('uses custom config overrides', () => {
    const custom: FallbackMessages = {
      timeout: { uk: 'Зачекайте UK', en: 'Wait EN' },
      busy: { uk: DEFAULTS.busy.uk, en: 'Busy EN' },
    };
    expect(resolveCustomerFallback('timeout', 'en', custom)).toBe('Wait EN');
    expect(resolveCustomerFallback('busy', 'en', custom)).toBe('Busy EN');
  });
});

describe('countConsecutiveFallbacksFromCodes', () => {
  it('counts busy/timeout codes and stops on real reply', () => {
    expect(
      countConsecutiveFallbacksFromCodes([
        { botFailureCode: 'timeout', text: 'custom en fallback' },
        { botFailureCode: 'busy', text: 'custom uk' },
        { botFailureCode: null, text: 'Real answer' },
      ]),
    ).toBe(2);
  });

  it('counts legacy text-only fallbacks without code', () => {
    expect(
      countConsecutiveFallbacksFromCodes([
        { botFailureCode: null, text: CUSTOMER_FALLBACK_TIMEOUT },
        { botFailureCode: null, text: 'Hi' },
      ]),
    ).toBe(1);
  });
});
