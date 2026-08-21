/**
 * Interrupt + close an Agent SDK `query()` handle.
 * `interrupt()` is best-effort (string-prompt mode may no-op); `close()` always runs.
 */

export const SDK_INTERRUPT_BUDGET_MS = 500;

export interface SdkQueryHandle {
  interrupt?: () => Promise<unknown>;
  close?: () => unknown;
}

export async function closeSdkQuery(
  query: SdkQueryHandle | undefined,
  opts: { interruptBudgetMs?: number } = {},
): Promise<void> {
  if (!query) return;
  const budget = opts.interruptBudgetMs ?? SDK_INTERRUPT_BUDGET_MS;
  if (typeof query.interrupt === 'function') {
    try {
      await Promise.race([
        Promise.resolve(query.interrupt()),
        new Promise<void>((resolve) => {
          setTimeout(resolve, budget);
        }),
      ]);
    } catch {
      /* already closed / not streaming */
    }
  }
  try {
    query.close?.();
  } catch {
    /* already closed */
  }
}
