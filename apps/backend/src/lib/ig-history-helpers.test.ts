import { describe, expect, it } from 'vitest';
import { clampIgHistoryLimit, isOwnIgHistorySender } from './ig-history-helpers.js';

describe('clampIgHistoryLimit', () => {
  it('defaults to 200 and caps at 200', () => {
    expect(clampIgHistoryLimit()).toBe(200);
    expect(clampIgHistoryLimit(500)).toBe(200);
    expect(clampIgHistoryLimit(20)).toBe(20);
  });
});

describe('isOwnIgHistorySender', () => {
  it('treats Page id and IBA id as the business', () => {
    expect(isOwnIgHistorySender('page-1', ['ig-1', 'page-1'])).toBe(true);
    expect(isOwnIgHistorySender('ig-1', ['ig-1', 'page-1'])).toBe(true);
    expect(isOwnIgHistorySender('client-9', ['ig-1', 'page-1'])).toBe(false);
  });
});
