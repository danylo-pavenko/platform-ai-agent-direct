import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path';

describe('safeReturnPath', () => {
  it('keeps an in-app page, including query and hash', () => {
    expect(safeReturnPath('/conversations/abc-123')).toBe('/conversations/abc-123');
    expect(safeReturnPath('/settings?tab=telegram')).toBe('/settings?tab=telegram');
    expect(safeReturnPath('/orders#row')).toBe('/orders#row');
  });

  it('reads the first value when the query is repeated', () => {
    expect(safeReturnPath(['/clients/1', '/orders'])).toBe('/clients/1');
  });

  it('rejects external and login targets', () => {
    expect(safeReturnPath('https://evil.example/settings')).toBeNull();
    expect(safeReturnPath('//evil.example/settings')).toBeNull();
    expect(safeReturnPath('/login')).toBeNull();
    expect(safeReturnPath('/login?redirect=/settings')).toBeNull();
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('settings')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });
});
