import { describe, expect, it } from 'vitest';
import {
  formatExistingVisitConfirmHint,
  isExistingVisitConfirmTurn,
  looksLikeShortVisitConfirmReply,
  looksLikeVisitReminderText,
} from './existing-visit-confirm.js';

const MOXITO_REMINDER = `Вітаю! Діана, нагадуємо, Ви записані до нас на послугу манікюру до молодшого майстра Надії

🗓️ 10.10 о 14:00

Підтвердіть, будь ласка, Ваш візит 🌸

Адміністратор Ольга ✨`;

describe('looksLikeVisitReminderText', () => {
  it('detects Moxito-style admin reminder', () => {
    expect(looksLikeVisitReminderText(MOXITO_REMINDER)).toBe(true);
  });

  it('ignores a normal slot offer', () => {
    expect(
      looksLikeVisitReminderText(
        'Вільні вікна на 10.10: 10:00 — Анна, 11:00 — Анна. Який час Вам зручний?',
      ),
    ).toBe(false);
  });
});

describe('looksLikeShortVisitConfirmReply', () => {
  it('accepts short confirms', () => {
    expect(looksLikeShortVisitConfirmReply('Підтверджую')).toBe(true);
    expect(looksLikeShortVisitConfirmReply('Так')).toBe(true);
    expect(looksLikeShortVisitConfirmReply('Буду')).toBe(true);
    expect(looksLikeShortVisitConfirmReply('Так, підтверджую')).toBe(true);
    expect(looksLikeShortVisitConfirmReply('Ок')).toBe(true);
  });

  it('rejects longer booking briefs', () => {
    expect(looksLikeShortVisitConfirmReply('Підтверджую на 14:00 до Анни на комплекс')).toBe(
      false,
    );
    expect(looksLikeShortVisitConfirmReply('Хочу записатися на манікюр завтра')).toBe(false);
  });
});

describe('isExistingVisitConfirmTurn', () => {
  it('matches reminder + Підтверджую', () => {
    expect(
      isExistingVisitConfirmTurn({
        clientMessage: 'Підтверджую',
        recentOutboundTexts: [MOXITO_REMINDER],
      }),
    ).toBe(true);
  });

  it('does not match when no reminder in outbound', () => {
    expect(
      isExistingVisitConfirmTurn({
        clientMessage: 'Підтверджую',
        recentOutboundTexts: [
          'Можемо запропонувати о 10:00 і 11:00 до Анни. Який час підходить?',
        ],
      }),
    ).toBe(false);
  });
});

describe('formatExistingVisitConfirmHint', () => {
  it('forbids slots and book', () => {
    const hint = formatExistingVisitConfirmHint({ reminderSnippet: MOXITO_REMINDER });
    expect(hint).toMatch(/Підтвердження існуючого візиту/);
    expect(hint).toMatch(/get_available_slots/);
    expect(hint).toMatch(/book_appointment/);
    expect(hint).toMatch(/10\.10/);
  });
});
