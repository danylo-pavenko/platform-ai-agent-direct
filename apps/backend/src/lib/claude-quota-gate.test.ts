import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetClaudeQuotaCircuitForTests,
  _setClaudeQuotaMemoryForTests,
  CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS,
  clearClaudeQuotaCircuit,
  evaluateClaudeSpawn,
  getClaudeQuotaCircuitState,
  isBotFailureRateLimited,
  isClaudeBackgroundSpawnBlocked,
  isClaudeQuotaCircuitOpen,
  noteClaudeRateLimit,
  parseClaudeResetToMs,
  shouldSkipForceLiveUsageRefresh,
  syncClaudeQuotaFromUsage,
  zonedWallTimeToUtcMs,
} from './claude-quota-gate.js';

describe('claude-quota-gate', () => {
  beforeEach(() => {
    _resetClaudeQuotaCircuitForTests();
  });

  describe('parseClaudeResetToMs', () => {
    it('parses ISO timestamps', () => {
      const ms = parseClaudeResetToMs('2026-08-14T17:40:00.000Z', Date.parse('2026-08-14T10:00:00.000Z'));
      expect(ms).toBe(Date.parse('2026-08-14T17:40:00.000Z'));
    });

    it('parses resets 7:40pm (Europe/Berlin)', () => {
      const now = Date.parse('2026-08-14T10:00:00.000Z'); // 12:00 Berlin (CEST)
      const ms = parseClaudeResetToMs(
        "You've hit your session limit · resets 7:40pm (Europe/Berlin)",
        now,
      );
      expect(ms).toBeTruthy();
      // 19:40 Berlin = 17:40 UTC in August
      expect(ms).toBe(zonedWallTimeToUtcMs({
        year: 2026,
        month: 8,
        day: 14,
        hour: 19,
        minute: 40,
        timeZone: 'Europe/Berlin',
      }));
    });

    it('parses dated reset Aug 14, 2:40pm (Europe/Berlin)', () => {
      const now = Date.parse('2026-08-14T08:00:00.000Z');
      const ms = parseClaudeResetToMs('Aug 14, 2:40pm (Europe/Berlin)', now);
      expect(ms).toBe(
        zonedWallTimeToUtcMs({
          year: 2026,
          month: 8,
          day: 14,
          hour: 14,
          minute: 40,
          timeZone: 'Europe/Berlin',
        }),
      );
    });

    it('parses hour-only weekly reset Aug 16, 6pm (Europe/Berlin)', () => {
      const now = Date.parse('2026-08-15T00:00:00.000Z');
      const ms = parseClaudeResetToMs(
        "You've hit your weekly limit · resets Aug 16, 6pm (Europe/Berlin)",
        now,
      );
      expect(ms).toBe(
        zonedWallTimeToUtcMs({
          year: 2026,
          month: 8,
          day: 16,
          hour: 18,
          minute: 0,
          timeZone: 'Europe/Berlin',
        }),
      );
    });

    it('parses clock-only 6pm without minutes', () => {
      const now = Date.parse('2026-08-15T10:00:00.000Z'); // afternoon UTC → evening Berlin
      const ms = parseClaudeResetToMs('resets 6pm (Europe/Berlin)', now);
      expect(ms).toBe(
        zonedWallTimeToUtcMs({
          year: 2026,
          month: 8,
          day: 15,
          hour: 18,
          minute: 0,
          timeZone: 'Europe/Berlin',
        }),
      );
    });
  });

  it('opens weekly circuit until Aug 16 6pm Berlin, not 5h fallback', () => {
    const now = Date.parse('2026-08-15T00:00:00.000Z');
    noteClaudeRateLimit(
      "api_error 429: You've hit your weekly limit · resets Aug 16, 6pm (Europe/Berlin)",
      now,
    );
    const until = zonedWallTimeToUtcMs({
      year: 2026,
      month: 8,
      day: 16,
      hour: 18,
      minute: 0,
      timeZone: 'Europe/Berlin',
    });
    expect(getClaudeQuotaCircuitState(now).blockedUntilMs).toBe(until);
    expect(getClaudeQuotaCircuitState(now).blockedUntilMs).toBeGreaterThan(
      now + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS,
    );
    // Idempotent: skip reasons must not shrink/reopen
    noteClaudeRateLimit(`hard_block_until:${new Date(until).toISOString()}`, now);
    expect(getClaudeQuotaCircuitState(now).blockedUntilMs).toBe(until);
  });

  it('soft-budget blocks background on weekly percent too', () => {
    _setClaudeQuotaMemoryForTests({
      blockedUntilMs: 0,
      sessionPercent: 10,
      weeklyPercent: 93,
      reason: null,
    });
    expect(evaluateClaudeSpawn('customer_dm').allowed).toBe(true);
    expect(evaluateClaudeSpawn('usage_refresh').allowed).toBe(false);
    expect(evaluateClaudeSpawn('auth_probe').softBudget).toBe(true);
  });

  it('opens circuit until parsed reset time', () => {
    const now = Date.parse('2026-08-14T10:00:00.000Z');
    noteClaudeRateLimit(
      "api_error 429: You've hit your session limit · resets 2:40pm (Europe/Berlin)",
      now,
    );
    const until = zonedWallTimeToUtcMs({
      year: 2026,
      month: 8,
      day: 14,
      hour: 14,
      minute: 40,
      timeZone: 'Europe/Berlin',
    });
    expect(isClaudeQuotaCircuitOpen(now)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(until - 1)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(until + 1)).toBe(false);
    expect(getClaudeQuotaCircuitState(now).blockedUntilMs).toBe(until);
  });

  it('falls back to default window when reset is not parseable', () => {
    const now = 1_000_000;
    noteClaudeRateLimit('api_error 429: rate_limit rejected', now);
    expect(isClaudeQuotaCircuitOpen(now)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(now + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS - 1)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(now + CLAUDE_QUOTA_CIRCUIT_DEFAULT_MS + 1)).toBe(false);
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

  it('hard-blocks all purposes while circuit open', () => {
    const now = Date.parse('2026-08-14T10:00:00.000Z');
    noteClaudeRateLimit(
      "You've hit your session limit · resets 7:40pm (Europe/Berlin)",
      now,
    );
    for (const purpose of [
      'customer_dm',
      'admin',
      'usage_refresh',
      'auth_probe',
      'warmup',
      'conversation_retry',
      'follow_up',
    ] as const) {
      expect(evaluateClaudeSpawn(purpose, { nowMs: now }).allowed).toBe(false);
    }
  });

  it('soft-budget blocks background but allows customer_dm', () => {
    _setClaudeQuotaMemoryForTests({
      blockedUntilMs: 0,
      sessionPercent: 92,
      reason: null,
    });
    expect(evaluateClaudeSpawn('customer_dm').allowed).toBe(true);
    expect(evaluateClaudeSpawn('admin').allowed).toBe(true);
    expect(evaluateClaudeSpawn('conversation_retry').allowed).toBe(false);
    expect(evaluateClaudeSpawn('usage_refresh').allowed).toBe(false);
    expect(evaluateClaudeSpawn('auth_probe').allowed).toBe(false);
    expect(evaluateClaudeSpawn('follow_up').allowed).toBe(false);
    expect(evaluateClaudeSpawn('warmup').softBudget).toBe(true);
  });

  it('skips forceLive while hard-blocked or soft-budgeted from usage', () => {
    const now = Date.parse('2026-08-14T10:00:00.000Z');
    expect(
      shouldSkipForceLiveUsageRefresh(
        {
          status: 'exhausted',
          checkedAt: '2026-08-14T09:00:00.000Z',
          buckets: [
            {
              id: 'current_session',
              label: 'Current session',
              percentUsed: 100,
              resetsAt: 'Aug 14, 2:40pm (Europe/Berlin)',
              resetsAtIso: '2026-08-14T12:40:00.000Z',
            },
          ],
        },
        now,
      ),
    ).toBe(true);
  });

  it('syncs percentages and reset from usage snapshot', () => {
    const now = Date.parse('2026-08-14T10:00:00.000Z');
    syncClaudeQuotaFromUsage(
      {
        status: 'exhausted',
        checkedAt: new Date(now).toISOString(),
        buckets: [
          {
            id: 'current_session',
            label: 'Current session',
            percentUsed: 100,
            resetsAt: 'display',
            resetsAtIso: '2026-08-14T17:40:00.000Z',
          },
        ],
      },
      now,
    );
    expect(isClaudeQuotaCircuitOpen(now)).toBe(true);
    expect(isClaudeQuotaCircuitOpen(Date.parse('2026-08-14T17:40:01.000Z'))).toBe(false);
  });

  it('blocks background spawns from memory', () => {
    expect(isClaudeBackgroundSpawnBlocked(null).blocked).toBe(false);
    noteClaudeRateLimit('429 session limit');
    expect(isClaudeBackgroundSpawnBlocked(null).blocked).toBe(true);
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
