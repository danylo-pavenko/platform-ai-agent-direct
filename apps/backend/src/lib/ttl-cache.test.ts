import { describe, expect, it } from 'vitest';
import { createTtlCache } from './ttl-cache.js';

describe('createTtlCache', () => {
  it('returns null when empty', () => {
    const cache = createTtlCache<string>(60_000);
    expect(cache.get()).toBeNull();
  });

  it('returns value within TTL', () => {
    const cache = createTtlCache<number[]>(60_000);
    cache.set([1, 2]);
    expect(cache.get()).toEqual([1, 2]);
  });

  it('expires after TTL', () => {
    const cache = createTtlCache<string>(1);
    cache.set('x');
    // busy-wait tiny bit past TTL
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* wait */
    }
    expect(cache.get()).toBeNull();
  });

  it('clear drops value', () => {
    const cache = createTtlCache<string>(60_000);
    cache.set('y');
    cache.clear();
    expect(cache.get()).toBeNull();
  });
});
