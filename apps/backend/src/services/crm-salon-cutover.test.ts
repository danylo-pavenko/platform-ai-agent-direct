import { describe, expect, it } from 'vitest';
import { SALON_CRM_ACTIONS } from '../lib/crm-routing.js';

describe('salon CRM cutover routing helpers', () => {
  it('moves only salon actions together', () => {
    expect(SALON_CRM_ACTIONS).toEqual([
      'services',
      'branches',
      'booking',
      'client_upsert',
    ]);
    expect(SALON_CRM_ACTIONS).not.toContain('catalog');
    expect(SALON_CRM_ACTIONS).not.toContain('order');
    expect(SALON_CRM_ACTIONS).not.toContain('lead');
  });
});
