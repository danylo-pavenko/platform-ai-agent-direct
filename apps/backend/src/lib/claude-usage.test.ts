import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/claude.js', () => ({
  getClaudeBinaryPath: () => '/usr/bin/claude',
}));

import { parseClaudeUsageText, parseUsageJsonStdout } from '../services/claude-usage.js';

const LEGACY_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Jun 15 at 4:39pm (Europe/Kiev)
Current week (all models): 6% used · resets Jun 21 at 6:59pm (Europe/Kiev)
Current week (Sonnet only): 1% used · resets Jun 21 at 6:59pm (Europe/Kiev)`;

/** Captured from Claude Code 2.1.220 — session omits resets at 0%; Fable week bucket. */
const MODERN_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used
Current week (all models): 10% used · resets Aug 1 at 10pm (Europe/Kiev)
Current week (Fable): 12% used · resets Aug 1 at 10pm (Europe/Kiev)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 236 requests · 4 sessions
  79% of your usage was at >150k context
  49% of your usage came from subagent-heavy sessions
  Top skills: /create-task 16%, /align-repos 4%, /commit-git 1%
  Top subagents: general-purpose 2%
  Top MCP servers: atlassian 16%

Last 7d · 1070 requests · 15 sessions
  85% of your usage came from subagent-heavy sessions`;

describe('parseClaudeUsageText', () => {
  it('parses legacy subscription usage buckets', () => {
    const snap = parseClaudeUsageText(LEGACY_SAMPLE);
    expect(snap.buckets).toHaveLength(3);
    expect(snap.worstPercent).toBe(24);
    expect(snap.status).toBe('ok');
    expect(snap.buckets[0].label).toBe('Current session');
  });

  it('parses modern format (optional resets + Fable week bucket)', () => {
    const snap = parseClaudeUsageText(MODERN_SAMPLE);
    expect(snap.buckets).toHaveLength(3);
    expect(snap.buckets.map((b) => b.label)).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Fable)',
    ]);
    expect(snap.buckets[0].percentUsed).toBe(0);
    expect(snap.buckets[0].resetsAt).toBe('—');
    expect(snap.buckets[2].percentUsed).toBe(12);
    expect(snap.worstPercent).toBe(12);
    expect(snap.status).toBe('ok');
    // Activity breakdown lines must not become buckets
    expect(snap.buckets.some((b) => b.label.toLowerCase().startsWith('top'))).toBe(false);
  });

  it('marks warning at 90%+', () => {
    const text = LEGACY_SAMPLE.replace('24%', '91%');
    const snap = parseClaudeUsageText(text);
    expect(snap.status).toBe('warning');
    expect(snap.worstPercent).toBe(91);
    expect(snap.message).toContain('91%');
  });

  it('marks exhausted at 100%', () => {
    const text = LEGACY_SAMPLE.replace('24%', '100%');
    const snap = parseClaudeUsageText(text);
    expect(snap.status).toBe('exhausted');
  });

  it('returns unavailable for empty parse', () => {
    const snap = parseClaudeUsageText('no usage data here');
    expect(snap.status).toBe('unavailable');
    expect(snap.buckets).toHaveLength(0);
  });
});

describe('parseUsageJsonStdout', () => {
  it('extracts result from single-line JSON with type=result', () => {
    const stdout = `${JSON.stringify({
      type: 'result',
      result: MODERN_SAMPLE,
      subtype: 'success',
    })}\n`;
    expect(parseUsageJsonStdout(stdout)).toBe(MODERN_SAMPLE);
  });

  it('skips warning lines before JSON', () => {
    const stdout = `Ignoring 8 permissions.allow entries from .claude/settings.json\n${JSON.stringify({
      type: 'result',
      result: 'Current session: 1% used · resets soon',
    })}\n`;
    expect(parseUsageJsonStdout(stdout)).toContain('Current session');
  });

  it('accepts subtype=success envelopes without type', () => {
    const stdout = JSON.stringify({
      subtype: 'success',
      result: 'Current session: 5% used',
    });
    expect(parseUsageJsonStdout(stdout)).toBe('Current session: 5% used');
  });
});
