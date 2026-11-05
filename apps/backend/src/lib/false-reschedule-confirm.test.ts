import { describe, expect, it } from 'vitest';
import {
  buildBookingMutationFailureAwareNudge,
  findFailedBookingMutation,
  isAgentChosenSilence,
  looksLikeRescheduleConfirmation,
  sanitizeFalseRescheduleConfirmReply,
  shouldSanitizeFalseRescheduleConfirm,
} from './false-reschedule-confirm.js';

describe('false-reschedule-confirm', () => {
  it('detects false «переношу / підтвердження надійде» claims', () => {
    expect(
      looksLikeRescheduleConfirmation(
        'Переношу Ваш запис з 15:00 на 13:00 — заявку вже передала на обробку, трохи зачекайте на підтвердження 🙂',
      ),
    ).toBe(true);
  });

  it('sanitizes only when reschedule tool failed', () => {
    expect(
      shouldSanitizeFalseRescheduleConfirm({
        responseText: 'Переношу Ваш запис на 13:00.',
        rescheduleToolCalled: true,
        rescheduleToolOk: false,
      }),
    ).toBe(true);
    expect(
      shouldSanitizeFalseRescheduleConfirm({
        responseText: 'Переношу Ваш запис на 13:00.',
        rescheduleToolCalled: true,
        rescheduleToolOk: true,
      }),
    ).toBe(false);
  });

  it('strips false claims without injecting a canned apology', () => {
    const out = sanitizeFalseRescheduleConfirmReply(
      'Доброго ранку, Анно! Переношу Ваш запис на 13:00.',
    );
    expect(out).toMatch(/Доброго ранку/i);
    expect(out).not.toMatch(/переношу/i);
    expect(out).not.toMatch(/адміністратору/i);
  });

  it('becomes empty (silence) when the whole draft was a false claim', () => {
    expect(
      sanitizeFalseRescheduleConfirmReply(
        'Переношу Ваш запис на 13:00 — підтвердження надійде за хвилину.',
      ),
    ).toBe('');
  });

  it('recognizes SILENCE token', () => {
    expect(isAgentChosenSilence('SILENCE')).toBe(true);
    expect(isAgentChosenSilence('[SILENCE]')).toBe(true);
    expect(isAgentChosenSilence('МОВЧАННЯ')).toBe(true);
    expect(isAgentChosenSilence('')).toBe(true);
    expect(isAgentChosenSilence('Передаю адміністратору.')).toBe(false);
  });

  it('builds an aware recovery nudge', () => {
    const nudge = buildBookingMutationFailureAwareNudge({
      tool: 'reschedule_appointment',
      toolResult: '[reschedule_appointment] failed: немає активного запису',
      managerForced: true,
    });
    expect(nudge).toMatch(/SILENCE/);
    expect(nudge).toMatch(/Відповісти по суті/);
    expect(nudge).toMatch(/немає активного запису/);
  });

  it('finds the latest failed booking mutation tool', () => {
    expect(
      findFailedBookingMutation([
        { name: 'get_available_slots', resultPreview: '[get_available_slots] ok' },
        {
          name: 'reschedule_appointment',
          resultPreview: '[reschedule_appointment] failed: немає активного запису',
        },
      ]),
    ).toEqual({
      tool: 'reschedule_appointment',
      toolResult: '[reschedule_appointment] failed: немає активного запису',
    });
    expect(
      findFailedBookingMutation([
        {
          name: 'reschedule_appointment',
          resultPreview: '[reschedule_appointment] ok: moved',
        },
      ]),
    ).toBeNull();
  });
});
