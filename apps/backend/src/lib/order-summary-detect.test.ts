import { describe, expect, it } from 'vitest';
import {
  isOrderConfirmationMessage,
  parseOrderSummaryFromText,
} from './order-summary-detect.js';

const SAMPLE = `Чудово, підтверджую замовлення:

Товар: Худі Багряний, L/XL - 2 189 ₴
Отримувач: Данило Павенко
Телефон: +380994561233
Доставка: НП Львів, відділення 71
Оплата: Післяплата

Передаю менеджеру для підтвердження та відправки.`;

describe('isOrderConfirmationMessage', () => {
  it('detects a full order summary', () => {
    expect(isOrderConfirmationMessage(SAMPLE)).toBe(true);
  });

  it('rejects casual product chat', () => {
    expect(isOrderConfirmationMessage('У нас є худі від 1500 ₴')).toBe(false);
  });
});

describe('parseOrderSummaryFromText', () => {
  it('parses Ukrainian order confirmation blocks', () => {
    const parsed = parseOrderSummaryFromText(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.customer_name).toBe('Данило Павенко');
    expect(parsed!.phone).toBe('+380994561233');
    expect(parsed!.city).toBe('Львів');
    expect(parsed!.np_branch).toBe('71');
    expect(parsed!.payment_method).toBe('Післяплата');
    expect(parsed!.items[0].name).toBe('Худі Багряний');
    expect(parsed!.items[0].variant).toBe('L/XL');
    expect(parsed!.items[0].price).toBe(2189);
  });
});
