import { describe, expect, it } from 'vitest';
import {
  clampFollowUpDelayHours,
  normalizeFollowUpConfig,
  FOLLOW_UP_DELAY_HOURS_MAX,
  FOLLOW_UP_DELAY_HOURS_DEFAULT,
  DEFAULT_FOLLOW_UP_TEMPLATE,
} from './follow-up-config.js';

describe('clampFollowUpDelayHours', () => {
  it('defaults invalid values to 72h (3 days)', () => {
    expect(clampFollowUpDelayHours(undefined)).toBe(FOLLOW_UP_DELAY_HOURS_DEFAULT);
    expect(clampFollowUpDelayHours('x')).toBe(FOLLOW_UP_DELAY_HOURS_DEFAULT);
  });

  it('clamps to 1..168', () => {
    expect(clampFollowUpDelayHours(0)).toBe(1);
    expect(clampFollowUpDelayHours(72)).toBe(72);
    expect(clampFollowUpDelayHours(99999)).toBe(FOLLOW_UP_DELAY_HOURS_MAX);
  });
});

describe('normalizeFollowUpConfig', () => {
  it('defaults enabled false and 72h', () => {
    const cfg = normalizeFollowUpConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.delayHours).toBe(72);
    expect(cfg.template).toBe(DEFAULT_FOLLOW_UP_TEMPLATE);
  });

  it('accepts enabled + custom delayHours', () => {
    const cfg = normalizeFollowUpConfig({
      enabled: true,
      delayHours: 48,
      template: '  Привіт знову  ',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.delayHours).toBe(48);
    expect(cfg.template).toBe('Привіт знову');
  });

  it('ignores legacy delayMinutes and uses default hours', () => {
    const cfg = normalizeFollowUpConfig({
      enabled: true,
      delayMinutes: 30,
    } as Partial<{ enabled: boolean; delayMinutes: number }>);
    expect(cfg.delayHours).toBe(72);
  });
});
