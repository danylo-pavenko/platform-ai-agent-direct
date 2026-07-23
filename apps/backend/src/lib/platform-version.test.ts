import { describe, expect, it } from 'vitest';
import { formatPlatformVersion, parsePlatformVersion } from './platform-version.js';

describe('parsePlatformVersion', () => {
  it('parses valid payload', () => {
    expect(parsePlatformVersion({ name: '1.2', code: 20 })).toEqual({ name: '1.2', code: 20 });
  });

  it('rejects invalid', () => {
    expect(parsePlatformVersion(null)).toBeNull();
    expect(parsePlatformVersion({ name: '', code: 1 })).toBeNull();
    expect(parsePlatformVersion({ name: '1.0', code: 0 })).toBeNull();
  });
});

describe('formatPlatformVersion', () => {
  it('formats label', () => {
    expect(formatPlatformVersion({ name: '1.0', code: 1 })).toBe('v1.0 (1)');
  });
});
