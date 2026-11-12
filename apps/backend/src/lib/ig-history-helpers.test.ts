import { describe, expect, it } from 'vitest';
import { clampIgHistoryLimit, isOwnIgHistorySender } from './ig-history-helpers.js';

describe('ig-history-helpers', () => {
  it('clamps limit and detects business senders', () => {
    expect(clampIgHistoryLimit()).toBe(200);
    expect(clampIgHistoryLimit(500)).toBe(200);
    expect(clampIgHistoryLimit(20)).toBe(20);
    expect(isOwnIgHistorySender('page-1', ['ig-1', 'page-1'])).toBe(true);
    expect(isOwnIgHistorySender('client-9', ['ig-1', 'page-1'])).toBe(false);
  });
});
