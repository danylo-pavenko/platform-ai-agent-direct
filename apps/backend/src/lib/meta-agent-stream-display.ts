/**
 * Hide the trailing JSON / fence payload while Claude is still streaming,
 * so SSE deltas only carry the short Ukrainian reply.
 */
export function visibleMetaAgentStreamText(raw: string): string {
  const text = String(raw ?? '');
  if (!text) return '';

  const fence = text.search(/```(?:json)?\s*[\r\n]*\{/i);
  if (fence !== -1) {
    return text.slice(0, fence).trimEnd();
  }

  const bareJson = text.search(/\n\s*\{\s*"(?:reply|diffs|libraryDrafts)"/);
  if (bareJson !== -1) {
    return text.slice(0, bareJson).trimEnd();
  }

  return text;
}
