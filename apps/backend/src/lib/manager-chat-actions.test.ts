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
  it('fills profile, slots, and booking tools on analyze_reply without creating a product order', () => {
    const msg = buildManagerForcedTurnUserMessage({
      action: 'analyze_reply',
      unansweredClientText: 'Давайте на 14:00, Анжела +380930152179',
      paymentRequisites: 'IBAN UA00',
      agentMode: 'booking',
      knownClient: { displayName: 'Анжела', phone: '+380930152179' },
      hasFreshSlotOffer: true,
    });
    expect(msg).toContain('Відповісти по суті');
    expect(msg).toContain('Давайте на 14:00');
    expect(msg).toContain('IBAN UA00');
    expect(msg).toContain('телефон +380930152179');
    expect(msg).toContain('Запропоновані вікна в сесії: ТАК');
    expect(msg).toContain('update_client_info');
    expect(msg).toContain('book_appointment');
    expect(msg).toContain('reschedule_appointment');
    expect(msg).toMatch(/Не викликай collect_order \/ create_local_order/);
    expect(msg).toContain('request_handoff');
    expect(msg).not.toMatch(/ЗАБОРОНЕНО: request_handoff, collect_order/);
  });

  it('asks for a slots lookup when the offer is missing', () => {
    const msg = buildManagerForcedTurnUserMessage({
      action: 'analyze_reply',
      unansweredClientText: 'Які є вікна завтра?',
      paymentRequisites: '',
      agentMode: 'general',
      hasFreshSlotOffer: false,
    });
    expect(msg).toContain('Режим агента: general');
    expect(msg).toMatch(/Запропоновані вікна в сесії: немає свіжих/);
    expect(msg).toContain('get_available_slots');
    expect(msg).toContain('Продаж товару');
    expect(msg).toContain('search_catalog');
  });

  it('uses catalog and delivery for sales without booking slots', () => {
    const msg = buildManagerForcedTurnUserMessage({
      action: 'analyze_reply',
      unansweredClientText: 'Худі таш L/XL, Київ, відділення 12. Карту дайте',
      paymentRequisites: 'IBAN UA00',
      agentMode: 'sales',
      knownClient: { deliveryCity: 'Київ', deliveryNpBranch: '12' },
      hasFreshSlotOffer: true,
    });
    expect(msg).toContain('Режим агента: sales');
    expect(msg).toContain('Продаж товару');
    expect(msg).toContain('search_catalog');
    expect(msg).toContain('get_delivery_cost');
    expect(msg).toContain('місто Київ');
    expect(msg).toMatch(/Не викликай collect_order \/ create_local_order/);
    expect(msg).not.toContain('get_available_slots');
    expect(msg).not.toContain('book_appointment');
    expect(msg).not.toContain('Запропоновані вікна');
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
