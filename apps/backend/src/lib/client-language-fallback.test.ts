import { describe, expect, it } from 'vitest';
import { detectClientLanguage, normalizeClientLanguage } from './client-language.js';
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
  it('detects Ukrainian from Cyrillic', () => {
    expect(detectClientLanguage('Добрий день! Хочу записатись на манікюр')).toBe('uk');
  });

  it('detects English from Latin', () => {
    expect(detectClientLanguage('Hi! I want to book a manicure tomorrow')).toBe('en');
  });

  it('returns null for short or emoji-only text', () => {
    expect(detectClientLanguage('👍')).toBeNull();
    expect(detectClientLanguage('ok')).toBeNull();
  });
});

describe('normalizeClientLanguage', () => {
  it('accepts uk and en only', () => {
    expect(normalizeClientLanguage('uk')).toBe('uk');
    expect(normalizeClientLanguage('en')).toBe('en');
    expect(normalizeClientLanguage('ru')).toBeNull();
    expect(normalizeClientLanguage(null)).toBeNull();
  });
});

describe('resolveCustomerFallback', () => {
  it('uses defaults by language', () => {
    expect(resolveCustomerFallback('timeout', 'uk', DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT);
    expect(resolveCustomerFallback('timeout', 'en', DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT_EN);
    expect(resolveCustomerFallback('busy', 'en', DEFAULTS)).toBe(CUSTOMER_FALLBACK_BUSY_EN);
  });

  it('falls back to uk for unknown language', () => {
    expect(resolveCustomerFallback('timeout', 'de', DEFAULTS)).toBe(CUSTOMER_FALLBACK_TIMEOUT);
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
