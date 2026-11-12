import { describe, expect, it } from 'vitest';
import { buildKeycrmOrderUrl, normalizeKeycrmAppUrl } from './keycrm-urls.js';

describe('keycrm-urls', () => {
  it('normalizes app URL and builds order deep links', () => {
    expect(normalizeKeycrmAppUrl('https://blessed.keycrm.app/')).toBe(
      'https://blessed.keycrm.app',
    );
    expect(normalizeKeycrmAppUrl('blessed.keycrm.app')).toBe('https://blessed.keycrm.app');
    expect(normalizeKeycrmAppUrl('')).toBeNull();
    expect(buildKeycrmOrderUrl('12345', 'https://blessed.keycrm.app')).toBe(
      'https://blessed.keycrm.app/app/orders/view/12345',
    );
    expect(buildKeycrmOrderUrl('12345', null)).toBeNull();
  });
});
