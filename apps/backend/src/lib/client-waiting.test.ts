import { describe, expect, it } from 'vitest';
import { mergeClientWhereWithWaitingIds } from './client-waiting.js';

describe('mergeClientWhereWithWaitingIds', () => {
  it('passes through when waiting filter is off', () => {
    const base = { phone: { contains: '380' } };
    expect(mergeClientWhereWithWaitingIds(base, null)).toEqual(base);
    expect(mergeClientWhereWithWaitingIds(undefined, null)).toBeUndefined();
  });

  it('returns empty id set when nobody is waiting', () => {
    expect(mergeClientWhereWithWaitingIds(undefined, [])).toEqual({ id: { in: [] } });
  });

  it('filters by waiting ids alone or AND with search', () => {
    expect(mergeClientWhereWithWaitingIds(undefined, ['a', 'b'])).toEqual({
      id: { in: ['a', 'b'] },
    });
    expect(
      mergeClientWhereWithWaitingIds({ phone: { contains: '93' } }, ['a']),
    ).toEqual({
      AND: [{ phone: { contains: '93' } }, { id: { in: ['a'] } }],
    });
  });
});
