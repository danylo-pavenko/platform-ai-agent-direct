import { describe, expect, it } from 'vitest';
import { buildKeycrmOrderUrl, normalizeKeycrmAppUrl } from './keycrm-urls.js';

describe('normalizeKeycrmAppUrl', () => {
  it('accepts full https URL', () => {
    expect(normalizeKeycrmAppUrl('https://blessed.keycrm.app/')).toBe(
      'https://blessed.keycrm.app',
    );
  });

  it('adds https when scheme omitted', () => {
    expect(normalizeKeycrmAppUrl('blessed.keycrm.app')).toBe('https://blessed.keycrm.app');
  });

  it('returns null for empty or invalid input', () => {
    expect(normalizeKeycrmAppUrl('')).toBeNull();
    expect(normalizeKeycrmAppUrl('   ')).toBeNull();
    expect(normalizeKeycrmAppUrl('not a url!!!')).toBeNull();
  });
});

describe('buildKeycrmOrderUrl', () => {
  it('builds order deep link when app URL is set', () => {
    expect(buildKeycrmOrderUrl('12345', 'https://blessed.keycrm.app')).toBe(
      'https://blessed.keycrm.app/order/view/12345',
    );
  });

  it('returns null without app URL', () => {
    expect(buildKeycrmOrderUrl('12345', null)).toBeNull();
  });
});
