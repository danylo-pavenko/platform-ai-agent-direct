/**
 * Classify Claude live-probe / auth-check text without spawning the CLI.
 */

export type ClaudeAuthFailureKind = 'auth' | 'temporary';

export interface ClaudeAuthHealth {
  ok: boolean;
  error: string | null;
  /**
   * When ok=false: `auth` = real OAuth/token failure (session expired).
   * `temporary` = timeout/busy/empty — credentials may still be valid.
   * Rate limits return ok=true (API authenticated, quota rejected).
   */
  failureKind?: ClaudeAuthFailureKind;
}

/** Detect expired/invalid OAuth tokens in CLI stderr, stdout, or API errors. */
export function isClaudeAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('401') ||
    lower.includes('invalid authentication') ||
    lower.includes('authentication credentials') ||
    lower.includes('not logged in') ||
    lower.includes('not authenticated') ||
    lower.includes('login required') ||
    lower.includes('run `claude auth login`') ||
    lower.includes('run "claude auth login"') ||
    lower.includes('run /login') ||
    lower.includes('please run /login')
  );
}

/** Quota / session window rejection — auth credentials are still valid. */
export function isClaudeRateLimitSignal(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  if (/you've hit your (session|weekly|usage) limit/.test(t)) return true;
  if (/hit your (session|usage) limit/.test(t)) return true;
  if (/\brate[_ ]?limit\b/.test(t)) return true;
  if (/api_error[_\s]?status["'\s:]*429/.test(t)) return true;
  if (/\b429\b/.test(t) && /(limit|rate|overage|quota)/.test(t)) return true;
  return false;
}

/**
 * Classify a live haiku-probe outcome. Pure helper for tests + verifyClaudeAuthLive.
 */
export function classifyClaudeLiveProbe(input: {
  text: string;
  errorDetail?: string | null;
  fallback?: 'busy' | 'timeout';
}): ClaudeAuthHealth {
  const combined = [input.text, input.errorDetail ?? ''].join('\n');

  if (isClaudeAuthFailure(combined)) {
    return {
      ok: false,
      failureKind: 'auth',
      error: 'Токен Claude недійсний або прострочений — увійдіть знову через Налаштування',
    };
  }

  // 429 / session limit: OAuth worked; subscription window is exhausted.
  if (isClaudeRateLimitSignal(combined)) {
    return { ok: true, error: null };
  }

  if (input.fallback) {
    return {
      ok: false,
      failureKind: 'temporary',
      error: input.errorDetail ?? 'Claude API тимчасово не відповідає',
    };
  }

  if (!input.text.trim()) {
    return {
      ok: false,
      failureKind: 'temporary',
      error: input.errorDetail ?? 'Claude API повернув порожню відповідь',
    };
  }

  return { ok: true, error: null };
}
