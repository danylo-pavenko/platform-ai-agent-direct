/** True when CLI stdout is an auth/error stub, not a customer-facing reply. */
export function isUnusableClaudeResultText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return (
    /not logged in|please run\s*\/login|authentication[_ ]failed|invalid api key|credit balance|overloaded_error/i.test(
      t,
    )
  );
}
