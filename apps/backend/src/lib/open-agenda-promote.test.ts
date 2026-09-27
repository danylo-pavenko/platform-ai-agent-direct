import { describe, expect, it } from 'vitest';
import {
  parseMastersLiveText,
  resolveUniqueMasterByName,
  resolveUniqueServiceByName,
} from './open-agenda-promote.js';
import type { CrmServiceItem } from '../services/crm/types.js';

const catalog: CrmServiceItem[] = [
  { id: 's1', name: 'Комплекс манікюр+педикюр', price: 1200, durationMin: 120 },
  { id: 's2', name: 'Манікюр класичний', price: 500, durationMin: 60 },
  { id: 's3', name: 'Манікюр з покриттям', price: 700, durationMin: 75 },
];

describe('open-agenda-promote', () => {
  it('resolves unique service by distinctive name', () => {
    expect(resolveUniqueServiceByName('комплекс', catalog)?.id).toBe('s1');
  });

  it('refuses ambiguous service names', () => {
    expect(resolveUniqueServiceByName('манікюр', catalog)).toBeNull();
  });

  it('resolves unique master by given name', () => {
    const masters = parseMastersLiveText(
      '[master_id=m1] Надія Старша\n[master_id=m2] Оля',
    );
    expect(resolveUniqueMasterByName('Надія', masters)?.id).toBe('m1');
    expect(resolveUniqueMasterByName('Марія', masters)).toBeNull();
  });
});
