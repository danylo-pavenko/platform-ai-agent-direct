import { describe, expect, it } from 'vitest';
import { summarizeHealthOverall } from './health-check.js';

describe('summarizeHealthOverall', () => {
  it('is ok when all checks are ok', () => {
    expect(summarizeHealthOverall([{ status: 'ok' }, { status: 'ok' }])).toBe('ok');
  });

  it('is ok when CRM/STT are only not_configured (no live failure)', () => {
    expect(
      summarizeHealthOverall([
        { status: 'ok' },
        { status: 'not_configured' },
        { status: 'not_configured' },
      ]),
    ).toBe('ok');
  });

  it('is degraded only when a check errors', () => {
    expect(
      summarizeHealthOverall([
        { status: 'ok' },
        { status: 'not_configured' },
        { status: 'error' },
      ]),
    ).toBe('degraded');
  });
});
