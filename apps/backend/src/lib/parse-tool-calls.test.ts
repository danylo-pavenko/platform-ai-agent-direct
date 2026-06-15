import { describe, expect, it } from 'vitest';
import { parseToolCallsFromText, stripToolCallBlocks } from './parse-tool-calls.js';

describe('parseToolCallsFromText', () => {
  it('parses a single tool_call block', () => {
    const text = `Дякуємо! Очікуйте підтвердження.

<tool_call>
{"name":"collect_order","args":{"customer_name":"Марія","payment_method":"cod"}}
</tool_call>`;

    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('collect_order');
    expect(calls[0].args.customer_name).toBe('Марія');
    expect(calls[0].args.payment_method).toBe('cod');
  });

  it('parses multiple tool_call blocks', () => {
    const text = `Ок.

<tool_call>
{"name":"update_client_info","args":{"phone":"+380991234567"}}
</tool_call>
<tool_call>
{"name":"collect_order","args":{"items":[{"name":"Худі","price":2189}]}}
</tool_call>`;

    expect(parseToolCallsFromText(text)).toHaveLength(2);
  });

  it('ignores malformed JSON', () => {
    const text = `<tool_call>not json</tool_call>`;
    expect(parseToolCallsFromText(text)).toHaveLength(0);
  });
});

describe('stripToolCallBlocks', () => {
  it('removes tool_call blocks from client-facing text', () => {
    const text = `Дякуємо!

<tool_call>
{"name":"collect_order","args":{}}
</tool_call>`;

    expect(stripToolCallBlocks(text)).toBe('Дякуємо!');
  });
});
