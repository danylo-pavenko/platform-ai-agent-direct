import { describe, expect, it } from 'vitest';
import {
  getLocalDateParts,
  needsClaudeAuthAlert,
  shouldRunDailyCheck,
} from './claude-auth-monitor.js';
import type { ClaudeAuthStatus } from './claude-auth.js';

function authStatus(overrides: Partial<ClaudeAuthStatus> = {}): ClaudeAuthStatus {
  return {
    binaryOk: true,
    binaryPath: '/usr/bin/claude',
    binaryVersion: '1.0.0',
    loggedIn: true,
    sessionExpired: false,
    authMethod: 'oauth',
    email: 'test@example.com',
    subscriptionType: 'pro',
    orgName: null,
    error: null,
    loginInProgress: false,
    ...overrides,
  };
}

describe('shouldRunDailyCheck', () => {
  it('runs once after the configured hour in timezone', () => {
    const atSeven = new Date('2026-06-26T04:00:00.000Z'); // 07:00 Europe/Kyiv (EEST)
    expect(shouldRunDailyCheck(atSeven, 7, 'Europe/Kyiv', null)).toEqual({
      run: true,
      dateKey: '2026-06-26',
    });
    expect(shouldRunDailyCheck(atSeven, 7, 'Europe/Kyiv', '2026-06-26')).toEqual({
      run: false,
      dateKey: '2026-06-26',
    });
  });

  it('catches up later the same day if the server was down at 07:00', () => {
    const atNine = new Date('2026-06-26T06:00:00.000Z'); // 09:00 Kyiv
    expect(shouldRunDailyCheck(atNine, 7, 'Europe/Kyiv', null).run).toBe(true);
  });

  it('does not run before the target hour', () => {
    const atSix = new Date('2026-06-26T03:00:00.000Z'); // 06:00 Kyiv
    expect(shouldRunDailyCheck(atSix, 7, 'Europe/Kyiv', null).run).toBe(false);
  });
});

describe('needsClaudeAuthAlert', () => {
  it('alerts when session expired or not logged in', () => {
    expect(needsClaudeAuthAlert(authStatus({ loggedIn: false, sessionExpired: true }))).toBe(true);
    expect(needsClaudeAuthAlert(authStatus({ loggedIn: false, sessionExpired: false }))).toBe(true);
    expect(needsClaudeAuthAlert(authStatus())).toBe(false);
  });

  it('skips while OAuth login is in progress', () => {
    expect(
      needsClaudeAuthAlert(
        authStatus({ loggedIn: false, sessionExpired: true, loginInProgress: true }),
      ),
    ).toBe(false);
  });
});

describe('getLocalDateParts', () => {
  it('formats date key in timezone', () => {
    const parts = getLocalDateParts('Europe/Kyiv', new Date('2026-06-26T04:00:00.000Z'));
    expect(parts.dateKey).toBe('2026-06-26');
    expect(parts.hour).toBe(7);
    expect(parts.minute).toBe(0);
  });
});
