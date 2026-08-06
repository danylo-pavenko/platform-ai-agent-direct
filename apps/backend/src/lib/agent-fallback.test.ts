import { describe, expect, it } from 'vitest';
import {
  AGENT_FALLBACK_MAX_BEFORE_HANDOFF,
  AGENT_FALLBACK_RETRY_NOTE,
  countConsecutiveFallbacksFromNewest,
  CUSTOMER_FALLBACK_TIMEOUT,
  formatBotFailureDetail,
  isAgentFallbackReply,
  isCustomerVisibleFallbackReply,
  isSuppressedFallbackRetryNote,
  shouldHandoffAfterAgentFallback,
  shouldSuppressDuplicateCustomerFallback,
} from './agent-fallback.js';

describe('isAgentFallbackReply', () => {
  it('matches canned fallback texts', () => {
    expect(isAgentFallbackReply(CUSTOMER_FALLBACK_TIMEOUT)).toBe(true);
  });

  it('matches suppressed retry notes', () => {
    expect(isAgentFallbackReply(AGENT_FALLBACK_RETRY_NOTE)).toBe(true);
    expect(isSuppressedFallbackRetryNote(AGENT_FALLBACK_RETRY_NOTE)).toBe(true);
  });

  it('rejects normal bot replies', () => {
    expect(isAgentFallbackReply('Вітаю! Як можу допомогти?')).toBe(false);
    expect(isCustomerVisibleFallbackReply(AGENT_FALLBACK_RETRY_NOTE)).toBe(false);
  });
});

describe('shouldSuppressDuplicateCustomerFallback', () => {
  it('suppresses when a prior canned fallback already exists after inbound', () => {
    expect(
      shouldSuppressDuplicateCustomerFallback({
        candidateText: CUSTOMER_FALLBACK_TIMEOUT,
        botOutboundsAfterInboundNewestFirst: [CUSTOMER_FALLBACK_TIMEOUT],
      }),
    ).toBe(true);
  });

  it('suppresses when a prior retry note exists', () => {
    expect(
      shouldSuppressDuplicateCustomerFallback({
        candidateText: CUSTOMER_FALLBACK_TIMEOUT,
        botOutboundsAfterInboundNewestFirst: [AGENT_FALLBACK_RETRY_NOTE],
      }),
    ).toBe(true);
  });

  it('does not suppress the first fallback for an inbound', () => {
    expect(
      shouldSuppressDuplicateCustomerFallback({
        candidateText: CUSTOMER_FALLBACK_TIMEOUT,
        botOutboundsAfterInboundNewestFirst: [],
      }),
    ).toBe(false);
  });

  it('does not suppress real replies', () => {
    expect(
      shouldSuppressDuplicateCustomerFallback({
        candidateText: 'Записала тебе на 15:00 до Іванки.',
        botOutboundsAfterInboundNewestFirst: [CUSTOMER_FALLBACK_TIMEOUT],
      }),
    ).toBe(false);
  });
});

describe('countConsecutiveFallbacksFromNewest', () => {
  it('counts only trailing fallbacks including retry notes', () => {
    expect(
      countConsecutiveFallbacksFromNewest([
        AGENT_FALLBACK_RETRY_NOTE,
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

describe('formatBotFailureDetail', () => {
  it('includes client message and technical timeout detail', () => {
    const detail = formatBotFailureDetail({
      code: 'timeout',
      errorDetail: 'timed out after 60000ms',
      clientMessage: 'Хочу замовити білу футболку xs',
    });
    expect(detail).toContain('timed out after 60000ms');
    expect(detail).toContain('Хочу замовити білу футболку xs');
  });

  it('describes queue overload for busy fallback', () => {
    const detail = formatBotFailureDetail({
      code: 'busy',
      errorDetail: 'queue overloaded (pending=11, active=2)',
    });
    expect(detail).toContain('перевантажений');
    expect(detail).toContain('queue overloaded');
  });

  it('includes original agent text for output_validation', () => {
    const detail = formatBotFailureDetail({
      code: 'output_validation',
      gateReason: 'meta_only',
      clientMessage: 'Привіт! На коли є вільно на манікюр?',
      agentText:
        'This is not a coding task. I should respond in character. product_id=9',
    });
    expect(detail).toContain('мета-роздуми');
    expect(detail).toContain('Привіт! На коли є вільно на манікюр?');
    expect(detail).toContain('Текст агента:');
    expect(detail).toContain('product_id=9');
  });
});
