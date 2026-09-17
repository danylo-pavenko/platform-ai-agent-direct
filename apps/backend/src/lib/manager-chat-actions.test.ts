import { describe, expect, it } from 'vitest';
import {
  PAYMENT_HUMAN_CONFIRM_NOTE,
  buildManagerForcedTurnUserMessage,
  formatPaymentRequisitesMessage,
  isManagerChatAction,
  mergePaymentHumanConfirmNote,
  normalizePaymentRequisites,
} from './manager-chat-actions.js';

describe('isManagerChatAction', () => {
  it('accepts the three admin chat actions', () => {
    expect(isManagerChatAction('send_payment_details')).toBe(true);
    expect(isManagerChatAction('analyze_reply')).toBe(true);
    expect(isManagerChatAction('complete_order')).toBe(true);
    expect(isManagerChatAction('reply')).toBe(false);
  });
});

describe('normalizePaymentRequisites', () => {
  it('trims and ignores non-strings', () => {
    expect(normalizePaymentRequisites('  UA123  ')).toBe('UA123');
    expect(normalizePaymentRequisites(null)).toBe('');
  });
});

describe('formatPaymentRequisitesMessage', () => {
  it('wraps a short card number', () => {
    const msg = formatPaymentRequisitesMessage('4149 1111 2222 3333');
    expect(msg).toContain('Реквізити для оплати');
    expect(msg).toContain('4149 1111 2222 3333');
    expect(msg).toMatch(/квитанц/i);
  });

  it('sends a full tenant template as-is', () => {
    const raw = 'Оплата на картку:\n4149…\nПісля оплати надішліть скрін.';
    expect(formatPaymentRequisitesMessage(raw)).toBe(raw);
  });
});

describe('mergePaymentHumanConfirmNote', () => {
  it('uses the canonical line when note is empty', () => {
    expect(mergePaymentHumanConfirmNote('')).toBe(PAYMENT_HUMAN_CONFIRM_NOTE);
  });

  it('appends without duplicating', () => {
    const once = mergePaymentHumanConfirmNote('Худі таш L/XL');
    expect(once).toContain('Худі таш L/XL');
    expect(once).toContain('ПОТРІБНЕ ПІДТВЕРДЖЕННЯ ЛЮДИНИ');
    expect(mergePaymentHumanConfirmNote(once)).toBe(once);
  });
});

describe('buildManagerForcedTurnUserMessage', () => {
  it('forbids handoff and orders on analyze_reply', () => {
    const msg = buildManagerForcedTurnUserMessage({
      action: 'analyze_reply',
      unansweredClientText: 'Давайте карту',
      paymentRequisites: 'IBAN UA00',
    });
    expect(msg).toContain('Відповісти по суті');
    expect(msg).toContain('Давайте карту');
    expect(msg).toContain('IBAN UA00');
    expect(msg).toContain('ЗАБОРОНЕНО: request_handoff, collect_order');
  });

  it('requires a local order and human payment confirm on complete_order', () => {
    const msg = buildManagerForcedTurnUserMessage({
      action: 'complete_order',
      unansweredClientText: '',
      paymentRequisites: '',
    });
    expect(msg).toContain('Оформити замовлення');
    expect(msg).toContain('create_local_order');
    expect(msg).toContain('ПОТРІБНЕ ПІДТВЕРДЖЕННЯ ЛЮДИНИ');
    expect(msg).toContain('не вигадуй IBAN');
  });
});
