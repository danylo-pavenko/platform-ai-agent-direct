import { describe, expect, it } from 'vitest';
import {
  buildBookingConfirmationText,
  looksLikeBookingConfirmationTease,
  looksLikeFirmBookingConfirmation,
  normalizeServiceStartTime,
} from './booking-confirmation.js';

describe('booking-confirmation', () => {
  it('normalizes HH:MM times', () => {
    expect(normalizeServiceStartTime('9:30')).toBe('09:30');
    expect(normalizeServiceStartTime('10:30:00')).toBe('10:30');
  });

  it('detects confirmation teases even when a clock time is present', () => {
    expect(
      looksLikeBookingConfirmationTease(
        'Дякую! Оформлюю Ваш запис — зараз надішлю підтвердження з деталями.',
      ),
    ).toBe(true);
    expect(
      looksLikeBookingConfirmationTease(
        'Ваш запит на запис передано в обробку — щойно система підтвердить бронювання, я одразу надішлю Вам деталі візиту 🌸\n\n📅 29.08.2026 о 10:00',
      ),
    ).toBe(true);
    expect(looksLikeFirmBookingConfirmation('Запис підтверджено на 26.08 о 10:30. Чекаємо!')).toBe(
      true,
    );
  });

  it('builds structured confirmation instead of a tease with a clock', () => {
    const text = buildBookingConfirmationText({
      date: '29.08.2026',
      time: '10:00',
      clientMessage:
        'Дякую, Анжело! Ваш запит на запис передано в обробку — щойно система підтвердить бронювання, я одразу надішлю Вам деталі візиту 🌸\n\n📅 29.08.2026 о 10:00',
      services: [
        { name: 'Комплекс манікюр', startTime: '10:00' },
        { name: 'Педикюр', startTime: '10:00' },
      ],
    });
    expect(text).toContain('Запис підтверджено на 29.08.2026');
    expect(text).toContain('Комплекс манікюр — 10:00');
    expect(text).not.toMatch(/передано в обробку|надішлю Вам деталі/i);
  });

  it('keeps a concrete Claude confirmation when present', () => {
    const msg = 'Записала вас на 26.08 о 10:30 — стрижка кінчиків. Чекаємо!';
    expect(
      buildBookingConfirmationText({
        date: '26.08.2026',
        time: '10:30',
        clientMessage: msg,
        services: [{ name: 'Стрижка кінчиків' }],
      }),
    ).toBe(msg);
  });
});
