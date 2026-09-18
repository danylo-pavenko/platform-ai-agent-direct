import { describe, expect, it } from 'vitest';
import {
  resolveClaudeHistoryWindow,
  startOfTenantCivilDay,
} from './claude-history-window.js';

describe('startOfTenantCivilDay', () => {
  it('is 21:00 UTC previous day for Kyiv in summer', () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    expect(startOfTenantCivilDay(now, 'Europe/Kyiv').toISOString()).toBe(
      '2026-09-18T21:00:00.000Z',
    );
  });
});

describe('resolveClaudeHistoryWindow', () => {
  const timeZone = 'Europe/Kyiv';
  const now = new Date('2026-09-19T12:00:00.000Z'); // 15:00 Kyiv

  it('starts at conversation createdAt when the thread began today', () => {
    const created = new Date('2026-09-19T08:00:00.000Z');
    const w = resolveClaudeHistoryWindow({
      now,
      timeZone,
      conversationCreatedAt: created,
      cycleMarkers: [],
    });
    expect(w.reason).toBe('conversation_start');
    expect(w.inclusive).toBe(true);
    expect(w.from.toISOString()).toBe(created.toISOString());
  });

  it('starts at civil midnight when the UUID is older than today', () => {
    const created = new Date('2026-09-10T10:00:00.000Z');
    const w = resolveClaudeHistoryWindow({
      now,
      timeZone,
      conversationCreatedAt: created,
      cycleMarkers: [],
    });
    expect(w.reason).toBe('civil_day');
    expect(w.inclusive).toBe(true);
    expect(w.from.toISOString()).toBe('2026-09-18T21:00:00.000Z');
  });

  it('starts after the latest completed order today', () => {
    const created = new Date('2026-09-19T07:00:00.000Z');
    const first = new Date('2026-09-19T09:00:00.000Z');
    const second = new Date('2026-09-19T11:00:00.000Z');
    const w = resolveClaudeHistoryWindow({
      now,
      timeZone,
      conversationCreatedAt: created,
      cycleMarkers: [{ at: first }, { at: second }],
    });
    expect(w.reason).toBe('after_order');
    expect(w.inclusive).toBe(false);
    expect(w.from.toISOString()).toBe(second.toISOString());
  });

  it('ignores yesterday’s order when computing today’s window', () => {
    const created = new Date('2026-09-10T10:00:00.000Z');
    const yesterday = new Date('2026-09-18T10:00:00.000Z');
    const w = resolveClaudeHistoryWindow({
      now,
      timeZone,
      conversationCreatedAt: created,
      cycleMarkers: [{ at: yesterday }],
    });
    expect(w.reason).toBe('civil_day');
    expect(w.inclusive).toBe(true);
  });
});
