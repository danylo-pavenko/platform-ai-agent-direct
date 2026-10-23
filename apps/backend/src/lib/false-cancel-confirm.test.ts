import { describe, expect, it } from 'vitest';
import {
  looksLikeCancelConfirmation,
  sanitizeFalseCancelConfirmReply,
  shouldSanitizeFalseCancelConfirm,
} from './false-cancel-confirm.js';

describe('false-cancel-confirm', () => {
  it('detects optimistic cancel claims from the Moxito incident', () => {
    expect(
      looksLikeCancelConfirmation(
        'Добре, передала запит на скасування Вашого візиту. Якщо матимете бажання записатися знову — будемо раді допомогти 🩷',
      ),
    ).toBe(true);
    expect(looksLikeCancelConfirmation('Дякуємо за розуміння! Ваш запис скасовано 🩷')).toBe(true);
    expect(looksLikeCancelConfirmation('Добре, скасовую Ваш запис на брови 🙏')).toBe(true);
  });

  it('allows soft ack without claiming cancel', () => {
    expect(
      looksLikeCancelConfirmation(
        'Дякуємо, що попередили. Підкажіть, зручніше перенести чи скасувати?',
      ),
    ).toBe(false);
  });

  it('sanitizes only when cancel tool failed', () => {
    expect(
      shouldSanitizeFalseCancelConfirm({
        responseText: 'Ваш запис скасовано',
        cancelToolCalled: true,
        cancelToolOk: false,
      }),
    ).toBe(true);
    expect(
      shouldSanitizeFalseCancelConfirm({
        responseText: 'Ваш запис скасовано',
        cancelToolCalled: true,
        cancelToolOk: true,
      }),
    ).toBe(false);
  });

  it('rewrites false cancel into handoff-safe copy', () => {
    const out = sanitizeFalseCancelConfirmReply(
      'Добре, передала запит на скасування Вашого візиту. Гарного дня!',
    );
    expect(out).toMatch(/ще не скасовано/i);
    expect(out).toMatch(/адміністратору/i);
    expect(out).not.toMatch(/передала запит на скасування/i);
  });
});
