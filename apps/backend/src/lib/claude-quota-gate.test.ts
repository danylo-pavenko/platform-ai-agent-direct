import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetClaudeQuotaCircuitForTests,
  CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS,
  clearClaudeQuotaCircuit,
  getClaudeQuotaCircuitState,
  isBotFailureRateLimited,
  isClaudeBackgroundSpawnBlocked,
  isClaudeQuotaCircuitOpen,
  noteClaudeRateLimit,
  shouldSkipForceLiveUsageRefresh,
} from './claude-quota-gate.js';

describe('claude-quota-gate', () => {
  beforeEach(() => {
    _resetClaudeQuotaCircuitForTests();
  });

  it('opens circuit on 429 / session limit detail', () => {
    const now = 1_000_000;
    noteClaudeRateLimit("api_error 429: You've hit your session limit · resets 2pm", now);
    expect(isClaudeQuotaCircuitOpen(now)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(now + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS - 1)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(now + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS + 1)).toBe(false);
    expect(getClaudeQuotaCircuitState(now).open).toBe(true);
  });

  it('ignores non-rate-limit details', () => {
    noteClaudeRateLimit('process error: EPIPE');
    expect(isClaudeQuotaCircuitOpen()).toBe(false);
  });

  it('clears circuit', () => {
    noteClaudeRateLimit('rate_limit');
    clearClaudeQuotaCircuit();
    expect(isClaudeQuotaCircuitOpen()).toBe(false);
  });

  it('skips forceLive while exhausted snapshot is fresh', () => {
    const now = Date.parse('2026-08-14T10:00:00.000Z');
    expect(
      shouldSkipForceLiveUsageRefresh(
        { status: 'exhausted', checkedAt: '2026-08-14T09:50:00.000Z' },
        now,
      ),
    ).toBe(true);
    expect(
      shouldSkipForceLiveUsageRefresh(
        { status: 'exhausted', checkedAt: '2026-08-14T09:00:00.000Z' },
        now,
      ),
    ).toBe(false);
    expect(
      shouldSkipForceLiveUsageRefresh(
        { status: 'ok', checkedAt: '2026-08-14T09:50:00.000Z' },
        now,
      ),
    ).toBe(false);
  });

  it('blocks background spawns from memory or exhausted snapshot', () => {
    expect(isClaudeBackgroundSpawnBlocked(null).blocked).toBe(false);
    noteClaudeRateLimit('429 session limit');
    expect(isClaudeBackgroundSpawnBlocked(null).reason).toBe('in_memory_rate_limit');
    clearClaudeQuotaCircuit();
    expect(
      isClaudeBackgroundSpawnBlocked({
        status: 'exhausted',
        checkedAt: new Date().toISOString(),
      }).reason,
    ).toBe('usage_snapshot_exhausted');
  });

  it('detects rate-limit botFailureDetail', () => {
    expect(
      isBotFailureRateLimited(
        "Ліміт сесії Claude (429). Деталі: You've hit your session limit · resets 2:40pm",
      ),
    ).toBe(true);
    expect(isBotFailureRateLimited('Агент перевантажений')).toBe(false);
  });
});
