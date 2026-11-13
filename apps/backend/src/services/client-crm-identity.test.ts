import { describe, expect, it } from 'vitest';
import { isValidIdentityProvider } from './client-crm-identity.js';
import { SALON_CRM_ACTIONS } from '../lib/crm-routing.js';

describe('client-crm-identity', () => {
  it('accepts known CRM providers', () => {
    expect(isValidIdentityProvider('beautypro')).toBe(true);
    expect(isValidIdentityProvider('altegio')).toBe(true);
    expect(isValidIdentityProvider('keycrm')).toBe(true);
    expect(isValidIdentityProvider('nope')).toBe(false);
  });

  it('keeps salon cutover actions separate from e-com', () => {
    expect(SALON_CRM_ACTIONS).toContain('booking');
    expect(SALON_CRM_ACTIONS).not.toContain('catalog');
  });
});
