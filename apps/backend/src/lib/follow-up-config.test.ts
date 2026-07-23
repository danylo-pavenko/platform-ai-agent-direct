import { describe, expect, it } from 'vitest';
import {
  clampFollowUpDelayMinutes,
  normalizeFollowUpConfig,
  FOLLOW_UP_DELAY_MAX,
  DEFAULT_FOLLOW_UP_TEMPLATE,
} from './follow-up-config.js';

describe('clampFollowUpDelayMinutes', () => {
  it('defaults invalid values to 30', () => {
    expect(clampFollowUpDelayMinutes(undefined)).toBe(30);
    expect(clampFollowUpDelayMinutes('x')).toBe(30);
  });

  it('clamps to 1..1440', () => {
    expect(clampFollowUpDelayMinutes(0)).toBe(1);
    expect(clampFollowUpDelayMinutes(30)).toBe(30);
    expect(clampFollowUpDelayMinutes(99999)).toBe(FOLLOW_UP_DELAY_MAX);
  });
});

describe('normalizeFollowUpConfig', () => {
  it('defaults enabled false and template', () => {
    const cfg = normalizeFollowUpConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.delayMinutes).toBe(30);
    expect(cfg.template).toBe(DEFAULT_FOLLOW_UP_TEMPLATE);
  });

  it('accepts enabled + custom template', () => {
    const cfg = normalizeFollowUpConfig({
      enabled: true,
      delayMinutes: 45,
      template: '  Привіт знову  ',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.delayMinutes).toBe(45);
    expect(cfg.template).toBe('Привіт знову');
  });
});
