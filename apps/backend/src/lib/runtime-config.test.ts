import { describe, expect, it } from 'vitest';
import {
  isUsernameBotIgnored,
  normalizeIgHandle,
  shouldProcessIncoming,
  type RuntimeConfig,
} from './runtime-config.js';

const baseConfig: RuntimeConfig = {
  mode: 'public',
  debugWhitelist: ['qa_user'],
  botIgnoreUsernames: ['blocked_user', 'spam'],
  backfillLimit: 200,
};

describe('normalizeIgHandle', () => {
  it('strips @ and lowercases', () => {
    expect(normalizeIgHandle('@Test_User')).toBe('test_user');
  });
});

describe('isUsernameBotIgnored', () => {
  it('matches ignore list case-insensitively', () => {
    expect(isUsernameBotIgnored(baseConfig, '@Blocked_User')).toBe(true);
    expect(isUsernameBotIgnored(baseConfig, 'normal_user')).toBe(false);
  });

  it('returns false for missing username', () => {
    expect(isUsernameBotIgnored(baseConfig, null)).toBe(false);
  });
});

describe('shouldProcessIncoming', () => {
  it('allows everyone in public mode regardless of ignore list', () => {
    expect(shouldProcessIncoming(baseConfig, 'blocked_user')).toBe(true);
  });

  it('filters by debug whitelist in debug mode', () => {
    const debug: RuntimeConfig = { ...baseConfig, mode: 'debug' };
    expect(shouldProcessIncoming(debug, 'qa_user')).toBe(true);
    expect(shouldProcessIncoming(debug, 'random')).toBe(false);
  });
});
