import { describe, expect, it } from 'vitest';
import {
  formatPlatformVersion,
  parsePlatformVersion,
  shouldRequestAutoUpdate,
} from './platform-version.js';

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

describe('shouldRequestAutoUpdate', () => {
  it('true only when remote code is strictly higher', () => {
    expect(shouldRequestAutoUpdate(10, 11)).toBe(true);
    expect(shouldRequestAutoUpdate(10, 10)).toBe(false);
    expect(shouldRequestAutoUpdate(11, 10)).toBe(false);
  });

  it('rejects non-finite', () => {
    expect(shouldRequestAutoUpdate(Number.NaN, 1)).toBe(false);
    expect(shouldRequestAutoUpdate(1, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
