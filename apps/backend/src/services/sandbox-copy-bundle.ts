export type SandboxFailureCode =
  | 'busy'
  | 'timeout'
  | 'output_validation'
  | 'exception'
  | 'empty';

export type SandboxFailure = {
  code: SandboxFailureCode;
  reasonUk: string;
  errorDetail?: string | null;
};

/** Plain-text bundle for admins to paste into Cursor for analysis. */
export function buildSandboxCopyBundle(input: {
  ok: boolean;
  failure: SandboxFailure | null;
  reply: string;
  lastUserMessage: string;
  debug: Record<string, unknown>;
}): string {
  return [
    '=== Sandbox agent debug (paste into Cursor) ===',
    `at: ${new Date().toISOString()}`,
    `ok: ${input.ok}`,
    `failure.code: ${input.failure?.code ?? 'none'}`,
    `failure.reasonUk: ${input.failure?.reasonUk ?? '—'}`,
    `failure.errorDetail: ${input.failure?.errorDetail ?? '—'}`,
    `lastUserMessage: ${JSON.stringify(input.lastUserMessage)}`,
    `reply: ${JSON.stringify(input.reply)}`,
    '--- debug JSON ---',
    JSON.stringify(input.debug, null, 2),
    '=== end ===',
  ].join('\n');
}
