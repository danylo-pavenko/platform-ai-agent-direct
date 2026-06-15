export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

const TOOL_CALL_BLOCK_RE =
  /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

/**
 * Extract tool invocations embedded in assistant text.
 * Claude headless CLI does not emit native tool_use blocks — we instruct
 * the model to append `<tool_call>{"name":"...","args":{...}}</tool_call>`.
 */
export function parseToolCallsFromText(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  for (const match of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as { name?: unknown; args?: unknown };
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) continue;
      const args =
        parsed.args !== null &&
        typeof parsed.args === 'object' &&
        !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      calls.push({ name: parsed.name.trim(), args });
    } catch {
      // Malformed JSON inside a tool_call block — skip
    }
  }

  return calls;
}

/** Remove tool_call blocks so clients never see internal protocol markup. */
export function stripToolCallBlocks(text: string): string {
  return text.replace(TOOL_CALL_BLOCK_RE, '').trim();
}
