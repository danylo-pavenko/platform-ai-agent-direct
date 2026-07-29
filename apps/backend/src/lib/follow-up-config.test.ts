import { describe, expect, it } from 'vitest';
import {
  clampFollowUpDelayHours,
  normalizeFollowUpConfig,
  FOLLOW_UP_DELAY_HOURS_MAX,
  FOLLOW_UP_DELAY_HOURS_DEFAULT,
} from './follow-up-config.js';

describe('clampFollowUpDelayHours', () => {
  it('defaults invalid values to 18h', () => {
    expect(clampFollowUpDelayHours(undefined)).toBe(FOLLOW_UP_DELAY_HOURS_DEFAULT);
    expect(clampFollowUpDelayHours('x')).toBe(FOLLOW_UP_DELAY_HOURS_DEFAULT);
  });

  it('clamps to 1..24', () => {
    expect(clampFollowUpDelayHours(0)).toBe(1);
    expect(clampFollowUpDelayHours(18)).toBe(18);
    expect(clampFollowUpDelayHours(24)).toBe(24);
    expect(clampFollowUpDelayHours(72)).toBe(FOLLOW_UP_DELAY_HOURS_MAX);
    expect(clampFollowUpDelayHours(99999)).toBe(FOLLOW_UP_DELAY_HOURS_MAX);
  });
});

describe('normalizeFollowUpConfig', () => {
  it('defaults enabled false and 18h', () => {
    const cfg = normalizeFollowUpConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.delayHours).toBe(18);
  });

  it('accepts enabled + custom delayHours and ignores legacy template', () => {
    const cfg = normalizeFollowUpConfig({
      enabled: true,
      delayHours: 12,
      template: '  Привіт знову  ',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.delayHours).toBe(12);
    expect(cfg).not.toHaveProperty('template');
  });

  it('clamps legacy high delayHours (e.g. 72) down to 24', () => {
    const cfg = normalizeFollowUpConfig({
      enabled: true,
      delayHours: 72,
    });
    expect(cfg.delayHours).toBe(24);
  });

  it('ignores legacy delayMinutes and uses default hours', () => {
    const cfg = normalizeFollowUpConfig({
      enabled: true,
      delayMinutes: 30,
    } as Partial<{ enabled: boolean; delayMinutes: number }>);
    expect(cfg.delayHours).toBe(18);
  });
});
