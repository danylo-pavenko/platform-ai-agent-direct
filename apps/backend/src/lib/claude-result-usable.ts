/** True when CLI stdout is an auth/error stub, not a customer-facing reply. */
export function isUnusableClaudeResultText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;

  // Full stream-json dumps leaked when the parser misses nested envelopes.
  if (
    t.includes('"type":"system"') &&
    t.includes('"subtype":"init"') &&
    (t.includes('"type":"result"') || t.includes('"type":"rate_limit_event"'))
  ) {
    return true;
  }

  return (
    /not logged in|please run\s*\/login|authentication[_ ]failed|invalid api key|credit balance|overloaded_error/i.test(
      t,
    ) ||
    /you've hit your (session|weekly|usage) limit|hit your (session|usage) limit/i.test(t) ||
    /\brate[_ ]?limit\b/i.test(t) ||
    /api[_ ]error[_ ]status|org_level_disabled|overageStatus/i.test(t)
  );
}
