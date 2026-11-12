import { describe, expect, it } from 'vitest';
import {
  formatPlatformVersion,
  parsePlatformVersion,
  shouldRequestAutoUpdate,
} from './platform-version.js';

describe('platform-version', () => {
  it('parses, formats, and compares remote codes', () => {
    expect(parsePlatformVersion({ name: '1.2', code: 20 })).toEqual({ name: '1.2', code: 20 });
    expect(parsePlatformVersion(null)).toBeNull();
    expect(formatPlatformVersion({ name: '1.0', code: 1 })).toBe('v1.0 (1)');
    expect(shouldRequestAutoUpdate(10, 11)).toBe(true);
    expect(shouldRequestAutoUpdate(10, 10)).toBe(false);
    expect(shouldRequestAutoUpdate(Number.NaN, 1)).toBe(false);
  });
});
