import { describe, expect, it } from 'vitest';
import {
  classifyClaudeLiveProbe,
  isClaudeAuthFailure,
  isClaudeRateLimitSignal,
} from './claude-auth-probe.js';

describe('isClaudeAuthFailure', () => {
  it('detects 401 invalid authentication', () => {
    expect(
      isClaudeAuthFailure('API Error: 401 Invalid authentication credentials'),
    ).toBe(true);
    expect(isClaudeAuthFailure('Please run /login')).toBe(true);
  });

  it('ignores rate limits and timeouts', () => {
    expect(isClaudeAuthFailure('timeout after 12000ms')).toBe(false);
    expect(
      isClaudeAuthFailure("You've hit your session limit · resets 9am"),
    ).toBe(false);
  });
});

describe('isClaudeRateLimitSignal', () => {
  it('detects session limit and 429 envelopes', () => {
    expect(
      isClaudeRateLimitSignal("You've hit your session limit · resets 9am (Europe/Berlin)"),
    ).toBe(true);
    expect(isClaudeRateLimitSignal('api_error 429: rate_limit rejected')).toBe(true);
  });
});

describe('classifyClaudeLiveProbe', () => {
  it('treats rate-limit as authenticated (ok)', () => {
    expect(
      classifyClaudeLiveProbe({
        text: '',
        errorDetail: "api_error 429: You've hit your session limit · resets 9am",
        fallback: 'timeout',
      }),
    ).toEqual({ ok: true, error: null });
  });

  it('marks real auth failures as auth', () => {
    const r = classifyClaudeLiveProbe({
      text: 'Please run /login',
      fallback: 'timeout',
    });
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe('auth');
  });

  it('marks empty/timeout without auth signal as temporary', () => {
    const r = classifyClaudeLiveProbe({
      text: '',
      errorDetail: 'unusable stream-json',
      fallback: 'timeout',
    });
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe('temporary');
  });
});
