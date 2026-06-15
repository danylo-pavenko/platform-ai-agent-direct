import { describe, expect, it } from 'vitest';
import { isKeycrmOrderArchived } from './keycrm-order-archive.js';

describe('isKeycrmOrderArchived', () => {
  it('returns true when closed_at is set', () => {
    expect(
      isKeycrmOrderArchived({
        closedAt: '2026-06-15 12:00:00',
        statusAlias: null,
        statusName: null,
      }),
    ).toBe(true);
  });

  it('detects archive status by alias', () => {
    expect(
      isKeycrmOrderArchived({
        closedAt: null,
        statusAlias: 'cancelled',
        statusName: 'Скасовано',
      }),
    ).toBe(true);
  });

  it('detects archive status by Ukrainian name', () => {
    expect(
      isKeycrmOrderArchived({
        closedAt: null,
        statusAlias: 'custom',
        statusName: 'В архіві',
      }),
    ).toBe(true);
  });

  it('returns false for active orders', () => {
    expect(
      isKeycrmOrderArchived({
        closedAt: null,
        statusAlias: 'new',
        statusName: 'Нове',
      }),
    ).toBe(false);
  });
});
