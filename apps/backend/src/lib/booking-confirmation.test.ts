import { describe, expect, it } from 'vitest';
import {
  buildBookingConfirmationText,
  looksLikeBookingConfirmationTease,
  normalizeServiceStartTime,
} from './booking-confirmation.js';

describe('booking-confirmation', () => {
  it('normalizes HH:MM times', () => {
    expect(normalizeServiceStartTime('9:30')).toBe('09:30');
    expect(normalizeServiceStartTime('10:30:00')).toBe('10:30');
  });

  it('detects confirmation teases without clock times', () => {
    expect(
      looksLikeBookingConfirmationTease(
        'Дякую! Оформлюю Ваш запис — зараз надішлю підтвердження з деталями.',
      ),
    ).toBe(true);
    expect(
      looksLikeBookingConfirmationTease(
        'Запис підтверджено на 26.08 о 10:30. Чекаємо!',
      ),
    ).toBe(false);
  });

  it('builds structured confirmation with per-service starts', () => {
    const text = buildBookingConfirmationText({
      date: '26.08.2026',
      time: '10:30',
      clientMessage: 'Оформлюю Ваш запис — зараз надішлю підтвердження з деталями. 🌸',
      services: [
        { name: 'Стрижка кінчиків', startTime: '10:30' },
        { name: 'Манікюр', startTime: '11:00' },
      ],
    });
    expect(text).toContain('26.08.2026');
    expect(text).toContain('Стрижка кінчиків — 10:30');
    expect(text).toContain('Манікюр — 11:00');
    expect(text).not.toMatch(/надішлю підтвердження/i);
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
