import { describe, expect, it } from 'vitest';
import { createTtlCache } from './ttl-cache.js';

describe('createTtlCache', () => {
  it('stores within TTL, expires, and clears', () => {
    const cache = createTtlCache<string>(60_000);
    expect(cache.get()).toBeNull();
    cache.set('y');
    expect(cache.get()).toBe('y');
    cache.clear();
    expect(cache.get()).toBeNull();

    const short = createTtlCache<string>(1);
    short.set('x');
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* wait past TTL */
    }
    expect(short.get()).toBeNull();
  });
});
