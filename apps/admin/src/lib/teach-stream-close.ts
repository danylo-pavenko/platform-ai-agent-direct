export type TeachStreamCloseKind = 'ok' | 'aborted' | 'silent_end';

/** After SSE body ends: require done/error, else treat as failure (unless aborted). */
export function resolveTeachStreamClose(opts: {
  gotDone: boolean;
  gotError: boolean;
  aborted: boolean;
}): TeachStreamCloseKind {
  if (opts.gotDone || opts.gotError) return 'ok';
  if (opts.aborted) return 'aborted';
  return 'silent_end';
}
