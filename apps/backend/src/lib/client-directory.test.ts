import { describe, expect, it } from 'vitest';
import { buildClientSearchWhere } from './client-directory.js';

describe('buildClientSearchWhere', () => {
  it('returns undefined for a blank query', () => {
    expect(buildClientSearchWhere('   ')).toBeUndefined();
  });

  it('matches name, handle, and order id', () => {
    const where = buildClientSearchWhere('Марина') as { OR: unknown[] };
    expect(where.OR.length).toBeGreaterThanOrEqual(5);
  });

  it('adds local phone variants for a +380 number', () => {
    const where = buildClientSearchWhere('+380991571312') as {
      OR: Array<{ phone?: { contains: string } }>;
    };
    const phones = where.OR.filter((c) => c.phone).map((c) => c.phone!.contains);
    expect(phones).toContain('0991571312');
    expect(phones).toContain('991571312');
  });
});
