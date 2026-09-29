import { describe, expect, it } from 'vitest';
import {
  buildFalseBookingConfirmNudge,
  looksLikeBookingConfirmation,
  sanitizeFalseBookingConfirmReply,
  shouldRecoverFalseBookingConfirm,
} from './false-booking-confirm.js';

describe('looksLikeBookingConfirmation', () => {
  it('detects Angela-style false confirm after price', () => {
    expect(
      looksLikeBookingConfirmation(
        '820 грн у Соломії за зняття, чистку і покриття, десь 115 хвилин 💅 Чекаємо тебе завтра о 11:00!',
      ),
    ).toBe(true);
  });

  it('detects «Чекаємо на тебе» confirmation', () => {
    expect(
      looksLikeBookingConfirmation(
        'Чудово, Данило! Записую тебе на завтра о 13:30. Чекаємо на тебе 🙏',
      ),
    ).toBe(true);
  });

  it('detects explicit booked claims', () => {
    expect(looksLikeBookingConfirmation('Записала тебе на завтра о 14:00.')).toBe(true);
    expect(looksLikeBookingConfirmation('Записали Вас до Аліни та Іванки 😊')).toBe(true);
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

describe('shouldRecoverFalseBookingConfirm', () => {
  it('does not rewrite a late-arrival “чекаємо” after notify_client_running_late', () => {
    expect(
      shouldRecoverFalseBookingConfirm({
        responseText: 'Нічого страшного, чекаємо на Вас 😊',
        clientMessage: 'Я до 5-7 хвилин запізнюсь, дуже перепрошую',
        lateNotifyCalled: true,
      }),
    ).toBe(false);
  });

  it('does not ask to re-confirm a slot when the client is only running late', () => {
    expect(
      shouldRecoverFalseBookingConfirm({
        responseText: 'Добре, чекаємо на Вас 😊 До зустрічі о 16:00!',
        clientMessage: 'Я до 5-7 хвилин запізнюсь, дуже перепрошую',
      }),
    ).toBe(false);
  });

  it('still recovers a hard booking claim without book_appointment', () => {
    expect(
      shouldRecoverFalseBookingConfirm({
        responseText: 'Чекаємо тебе завтра о 11:00!',
        clientMessage: 'Так, запишіть',
      }),
    ).toBe(true);
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
