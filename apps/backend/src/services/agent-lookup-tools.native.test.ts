import { describe, expect, it } from 'vitest';
import { hasNativeLookupResult, lookupResultFromResponse } from './agent-lookup-tools.js';

describe('hasNativeLookupResult', () => {
  it('is true for a real lookup dump', () => {
    expect(
      hasNativeLookupResult(
        [{ name: 'search_services', result: '[search_services] РЕЗУЛЬТАТ: …' }],
        'search_services',
      ),
    ).toBe(true);
  });

  it('is false for HOST_QUEUED stubs', () => {
    expect(
      hasNativeLookupResult(
        [{ name: 'book_appointment', result: '[book_appointment] HOST_QUEUED — …' }],
        'book_appointment',
      ),
    ).toBe(false);
  });

  it('is false when missing', () => {
    expect(hasNativeLookupResult(undefined, 'search_services')).toBe(false);
    expect(lookupResultFromResponse([], 'search_services')).toBeUndefined();
  });
});
