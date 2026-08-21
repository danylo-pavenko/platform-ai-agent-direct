import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_SAFE_META_FALLBACK,
  gateCustomerFacingReply,
  looksLikeAssistantMetaReasoning,
  redactLeakedInternalIds,
  sanitizeCustomerFacingReply,
  stripAssistantMetaReasoning,
  stripMarkdownCodeFences,
  stripStandaloneJsonArtifacts,
} from './assistant-output.js';

describe('stripAssistantMetaReasoning', () => {
  it('strips the Moxito-style English preamble before Ukrainian reply', () => {
    const raw =
      'This is an Instagram DM from a customer of Moxito Beauty Studio, not a coding task. I should respond in character per the system prompt, in Ukrainian. Привіт! 👋 У нас працює салон краси.';
    expect(stripAssistantMetaReasoning(raw)).toBe(
      'Привіт! 👋 У нас працює салон краси.',
    );
  });

  it('strips a separate English paragraph', () => {
    const raw =
      'This is not a coding task. I should respond in character.\n\nДобрий день! Що шукаєте?';
    expect(stripAssistantMetaReasoning(raw)).toBe('Добрий день! Що шукаєте?');
  });

  it('leaves clean Ukrainian replies alone', () => {
    const raw = 'Привіт! У нас є худі та футболки. Що цікавить?';
    expect(stripAssistantMetaReasoning(raw)).toBe(raw);
  });

  it('leaves English product names inside a Ukrainian reply', () => {
    const raw = 'Так, модель Oversized Hoodie є в наявності у розмірі M.';
    expect(stripAssistantMetaReasoning(raw)).toBe(raw);
  });

  it('strips “The user is asking…” style preamble', () => {
    const raw =
      'The user is asking what is available. I should respond in character. Привіт! Що шукаєте?';
    expect(stripAssistantMetaReasoning(raw)).toBe('Привіт! Що шукаєте?');
  });

  it('keeps UA copy even when a meta marker appears in the same string', () => {
    const raw =
      'knowledge base підказує: ліпідне відновлення підходить для сухого волосся. Записати вас?';
    expect(stripAssistantMetaReasoning(raw)).toBe(raw);
  });

  it('does not wipe long UA replies that also match a meta marker (cyrillicCount regression)', () => {
    // Historical bug: non-global Cyrillic regex made cyrillicCount always 0|1,
    // so any META_MARKERS hit emptied the whole UA reply → empty_after_sanitize.
    const raw =
      'Looking at this prompt briefly. Ліпідне відновлення волосся у нас є — підкажіть довжину, і я підберу програму та вільний час.';
    const out = stripAssistantMetaReasoning(raw);
    expect(out).toMatch(/Ліпідне відновлення/);
    expect(out.length).toBeGreaterThan(40);
  });
});

describe('looksLikeAssistantMetaReasoning', () => {
  it('detects coding-persona markers', () => {
    expect(
      looksLikeAssistantMetaReasoning(
        'This is an Instagram DM, not a coding task. I should respond in Ukrainian.',
      ),
    ).toBe(true);
  });

  it('rejects normal customer copy', () => {
    expect(looksLikeAssistantMetaReasoning('Привіт! Хочу записатись.')).toBe(false);
  });
});

describe('stripMarkdownCodeFences', () => {
  it('removes fenced json dumps', () => {
    const raw = 'Ось варіанти:\n\n```json\n{"name":"x"}\n```\n\nПишіть якщо треба.';
    expect(stripMarkdownCodeFences(raw)).toBe('Ось варіанти:\n\n\n\nПишіть якщо треба.');
  });
});

describe('stripStandaloneJsonArtifacts', () => {
  it('drops a whole-message JSON object', () => {
    expect(stripStandaloneJsonArtifacts('{"name":"collect_order","args":{}}')).toBe('');
  });

  it('keeps prose', () => {
    expect(stripStandaloneJsonArtifacts('Ціна від 500 ₴.')).toBe('Ціна від 500 ₴.');
  });
});

describe('sanitizeCustomerFacingReply', () => {
  it('strips thinking XML, fences, and meta preamble together', () => {
    const raw = [
      '<thinking>plan the reply</thinking>',
      'This is not a coding task. I should respond in Ukrainian.',
      '',
      '```js',
      'console.log(1)',
      '```',
      '',
      'Привіт! Готові оформити?',
    ].join('\n');
    expect(sanitizeCustomerFacingReply(raw)).toBe('Привіт! Готові оформити?');
  });

  it('drops whole-message English tool/config rant with no client reply', () => {
    const raw = [
      "There's a mismatch: the tools provided (search_catalog, get_delivery_cost,",
      'collect_order, create_local_order) are e-commerce sales-mode shop tools,',
      "not a marketing agency's lead-gen tools. Per CLAUDE.md this tenant should",
      'use classify_intent / submit_brief. The system prompt business identity',
      "doesn't match the knowledge base, the tools, or the customer context at all.",
      "This is an entirely different company's script attached to different data.",
    ].join(' ');
    expect(sanitizeCustomerFacingReply(raw)).toBe('');
  });
});

describe('redactLeakedInternalIds', () => {
  it('scrubs product/offer/service/master ids but keeps prices', () => {
    const { text, redacted } = redactLeakedInternalIds(
      'Манікюр 850 грн, product_id=42, [master_id=abc-1] у Олі, purchased_price=100',
    );
    expect(redacted).toBe(true);
    expect(text).not.toMatch(/product_id|master_id/i);
    expect(text).toContain('850 грн');
    expect(text).toContain('purchased_price=100');
    expect(text).toContain('у Олі');
  });

  it('leaves clean copy untouched', () => {
    const raw = 'На завтра є 14:00 у Анастасії, 930 грн.';
    expect(redactLeakedInternalIds(raw)).toEqual({ text: raw, redacted: false });
  });
});

describe('gateCustomerFacingReply', () => {
  it('passes clean Ukrainian replies through', () => {
    const raw = 'Добрий день! Чим можу допомогти?';
    expect(gateCustomerFacingReply(raw)).toEqual({
      text: raw,
      rejected: false,
      reason: 'ok',
      redactedInternals: false,
    });
  });

  it('passes lipid restoration UA reply without fallback', () => {
    const raw =
      'Ліпідне відновлення — чудовий вибір! Тривалість близько 60–90 хв. Підкажіть зручну дату?';
    const gated = gateCustomerFacingReply(raw);
    expect(gated.rejected).toBe(false);
    expect(gated.reason).toBe('ok');
    expect(gated.text).toBe(raw);
    expect(gated.text).not.toBe(CUSTOMER_SAFE_META_FALLBACK);
  });

  it('replaces whole-message toolset rant with safe fallback (no manager promise)', () => {
    const raw = [
      "There's a mismatch between the tools provided and CLAUDE.md:",
      'e-commerce sales-mode collect_order vs lead-gen submit_brief.',
      'The system prompt business identity does not match the knowledge base.',
    ].join(' ');
    const gated = gateCustomerFacingReply(raw);
    expect(gated.rejected).toBe(true);
    expect(gated.reason).toBe('meta_only');
    expect(gated.text).toBe(CUSTOMER_SAFE_META_FALLBACK);
    expect(gated.text).not.toMatch(/менеджер/i);
  });

  it('replaces thinking-only reply with fallback (no manager promise)', () => {
    const gated = gateCustomerFacingReply('<thinking>search lipid service then reply</thinking>');
    expect(gated.rejected).toBe(true);
    expect(gated.reason).toBe('empty_after_sanitize');
    expect(gated.text).toBe(CUSTOMER_SAFE_META_FALLBACK);
    expect(gated.text).not.toMatch(/менеджер/i);
  });

  it('redacts leaked IDs but still sends the customer text', () => {
    const gated = gateCustomerFacingReply(
      'Беру product_id=42 на манікюр за 850 грн у Олі',
    );
    expect(gated.rejected).toBe(false);
    expect(gated.reason).toBe('ok');
    expect(gated.redactedInternals).toBe(true);
    expect(gated.text).not.toMatch(/product_id/i);
    expect(gated.text).toContain('850 грн');
    expect(gated.text).toContain('у Олі');
  });

  it('keeps UA with service_id bracket and strips the id', () => {
    const gated = gateCustomerFacingReply(
      'У нас є Ліпідне відновлення волосся [service_id=xxx-yyy]. Ціна від 1500 грн.',
    );
    expect(gated.rejected).toBe(false);
    expect(gated.reason).toBe('ok');
    expect(gated.redactedInternals).toBe(true);
    expect(gated.text).not.toMatch(/service_id/i);
    expect(gated.text).toContain('Ліпідне відновлення');
    expect(gated.text).toContain('1500 грн');
  });

  it('allows prices including purchased_price wording', () => {
    const gated = gateCustomerFacingReply('Ціна 930 грн, purchased_price орієнтовно така сама.');
    expect(gated.rejected).toBe(false);
    expect(gated.text).toContain('930 грн');
    expect(gated.text).toContain('purchased_price');
  });

  it('keeps Ukrainian reply after stripping English meta preamble', () => {
    const raw =
      'This is an Instagram DM from a customer, not a coding task. I should respond in character.\n\nПривіт! Що шукаєте?';
    const gated = gateCustomerFacingReply(raw);
    expect(gated.rejected).toBe(false);
    expect(gated.text).toBe('Привіт! Що шукаєте?');
  });

  it('rescues UA copy when aggressive sanitize would empty mixed meta+UA', () => {
    const raw =
      'Looking at this message / knowledge base tools provided.\n\nЛіпідна програма є — можу підказати тривалість і записати вас.';
    const gated = gateCustomerFacingReply(raw);
    expect(gated.rejected).toBe(false);
    expect(gated.reason).toBe('ok');
    expect(gated.text).toMatch(/Ліпідна/);
    expect(gated.text).not.toBe(CUSTOMER_SAFE_META_FALLBACK);
  });
});
