import { describe, expect, it } from 'vitest';
import { shouldNotifyHandoffFollowUp } from './handoff-telegram.js';

describe('shouldNotifyHandoffFollowUp', () => {
  it('allows the first client message after escalation', () => {
    expect(shouldNotifyHandoffFollowUp(0)).toBe(true);
  });

  it('skips the second and later follow-ups', () => {
    expect(shouldNotifyHandoffFollowUp(1)).toBe(false);
    expect(shouldNotifyHandoffFollowUp(4)).toBe(false);
  });
});
