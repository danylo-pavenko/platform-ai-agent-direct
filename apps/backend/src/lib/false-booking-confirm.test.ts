import { describe, expect, it } from 'vitest';
import {
  buildFalseBookingConfirmNudge,
  looksLikeBookingConfirmation,
  sanitizeFalseBookingConfirmReply,
} from './false-booking-confirm.js';

describe('looksLikeBookingConfirmation', () => {
  it('detects Angela-style false confirm after price', () => {
    expect(
      looksLikeBookingConfirmation(
        '820 грн у Соломії за зняття, чистку і покриття, десь 115 хвилин 💅 Чекаємо тебе завтра о 11:00!',
      ),
    ).toBe(true);
  });

  it('detects explicit booked claims', () => {
    expect(looksLikeBookingConfirmation('Записала тебе на завтра о 14:00.')).toBe(true);
    expect(looksLikeBookingConfirmation('Ти записана до Олі на 16:30.')).toBe(true);
    expect(looksLikeBookingConfirmation('Бачимось завтра о 11:00!')).toBe(true);
  });

  it('allows pure booking questions', () => {
    expect(looksLikeBookingConfirmation('Можемо записати на завтра?')).toBe(false);
    expect(looksLikeBookingConfirmation('Хочеш, запишемо тебе на пʼятницю?')).toBe(false);
  });

  it('allows price-only replies', () => {
    expect(
      looksLikeBookingConfirmation(
        '820 грн у Соломії за зняття, чистку і покриття, десь 115 хвилин 💅',
      ),
    ).toBe(false);
  });
});

describe('sanitizeFalseBookingConfirmReply', () => {
  it('keeps price facts and drops waiting-for-you claim', () => {
    const out = sanitizeFalseBookingConfirmReply(
      '820 грн у Соломії за зняття, чистку і покриття, десь 115 хвилин 💅 Чекаємо тебе завтра о 11:00!',
    );
    expect(out).toMatch(/820/);
    expect(out).not.toMatch(/Чекаємо тебе/i);
    expect(out).toMatch(/підтвердь дату/i);
  });
});

describe('buildFalseBookingConfirmNudge', () => {
  it('requires book_appointment', () => {
    expect(buildFalseBookingConfirmNudge()).toMatch(/book_appointment/);
    expect(buildFalseBookingConfirmNudge()).toMatch(/Заборонено підтверджувати/);
  });
});
