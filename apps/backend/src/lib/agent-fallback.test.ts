import { describe, expect, it } from 'vitest';
import {
  AGENT_FALLBACK_MAX_BEFORE_HANDOFF,
  countConsecutiveFallbacksFromNewest,
  CUSTOMER_FALLBACK_TIMEOUT,
  isAgentFallbackReply,
  shouldHandoffAfterAgentFallback,
} from './agent-fallback.js';

describe('isAgentFallbackReply', () => {
  it('matches canned fallback texts', () => {
    expect(isAgentFallbackReply(CUSTOMER_FALLBACK_TIMEOUT)).toBe(true);
  });

  it('rejects normal bot replies', () => {
    expect(isAgentFallbackReply('Вітаю! Як можу допомогти?')).toBe(false);
  });
});

describe('countConsecutiveFallbacksFromNewest', () => {
  it('counts only trailing fallbacks', () => {
    expect(
      countConsecutiveFallbacksFromNewest([
        CUSTOMER_FALLBACK_TIMEOUT,
        CUSTOMER_FALLBACK_TIMEOUT,
        'Реальна відповідь',
      ]),
    ).toBe(2);
  });
});

describe('shouldHandoffAfterAgentFallback', () => {
  it('hands off after max prior fallbacks', () => {
    expect(shouldHandoffAfterAgentFallback(AGENT_FALLBACK_MAX_BEFORE_HANDOFF)).toBe(true);
    expect(shouldHandoffAfterAgentFallback(AGENT_FALLBACK_MAX_BEFORE_HANDOFF - 1)).toBe(false);
  });
});
