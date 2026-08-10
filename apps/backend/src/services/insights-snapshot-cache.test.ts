import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearInsightsSnapshotCache,
  getCachedInsightsSnapshotForTest,
  INSIGHTS_SNAPSHOT_TTL_MS,
  setCachedInsightsSnapshotForTest,
  type InsightsSnapshot,
} from './insights-snapshot.js';

function stubSnapshot(period: '7d' | '30d'): InsightsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    period,
    periodLabel: period === '7d' ? 'за останні 7 днів' : 'за останні 30 днів',
    from: null,
    to: new Date().toISOString(),
    business: { brandName: 'Test' },
    totalsAllTime: {
      conversations: 1,
      messages: 1,
      inboundMessages: 1,
      botReplies: 0,
      managerReplies: 0,
      clients: 1,
    },
    conversations: { active: 0 },
    messages: { total: 0 },
    clients: { total: 1, active: 0 },
    samples: [],
    recentAll: [],
  } as InsightsSnapshot;
}

describe('insights snapshot TTL cache', () => {
  afterEach(() => {
    clearInsightsSnapshotCache();
    vi.useRealTimers();
  });

  it('returns cached snapshot within TTL for the same period', () => {
    const snap = stubSnapshot('7d');
    setCachedInsightsSnapshotForTest('7d', snap);
    expect(getCachedInsightsSnapshotForTest('7d')).toBe(snap);
  });

  it('misses when period differs', () => {
    setCachedInsightsSnapshotForTest('7d', stubSnapshot('7d'));
    expect(getCachedInsightsSnapshotForTest('30d')).toBeNull();
  });

  it('misses after TTL expires', () => {
    vi.useFakeTimers();
    setCachedInsightsSnapshotForTest('7d', stubSnapshot('7d'));
    vi.advanceTimersByTime(INSIGHTS_SNAPSHOT_TTL_MS + 1);
    expect(getCachedInsightsSnapshotForTest('7d')).toBeNull();
  });

  it('clearInsightsSnapshotCache drops the entry', () => {
    setCachedInsightsSnapshotForTest('7d', stubSnapshot('7d'));
    clearInsightsSnapshotCache();
    expect(getCachedInsightsSnapshotForTest('7d')).toBeNull();
  });
});
