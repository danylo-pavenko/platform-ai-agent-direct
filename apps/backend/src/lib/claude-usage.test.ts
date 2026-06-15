import { describe, expect, it } from 'vitest';
import { parseClaudeUsageText } from '../services/claude-usage.js';

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Jun 15 at 4:39pm (Europe/Kiev)
Current week (all models): 6% used · resets Jun 21 at 6:59pm (Europe/Kiev)
Current week (Sonnet only): 1% used · resets Jun 21 at 6:59pm (Europe/Kiev)`;

describe('parseClaudeUsageText', () => {
  it('parses subscription usage buckets', () => {
    const snap = parseClaudeUsageText(SAMPLE);
    expect(snap.buckets).toHaveLength(3);
    expect(snap.worstPercent).toBe(24);
    expect(snap.status).toBe('ok');
    expect(snap.buckets[0].label).toBe('Current session');
  });

  it('marks warning at 90%+', () => {
    const text = SAMPLE.replace('24%', '91%');
    const snap = parseClaudeUsageText(text);
    expect(snap.status).toBe('warning');
    expect(snap.worstPercent).toBe(91);
    expect(snap.message).toContain('91%');
  });

  it('marks exhausted at 100%', () => {
    const text = SAMPLE.replace('24%', '100%');
    const snap = parseClaudeUsageText(text);
    expect(snap.status).toBe('exhausted');
  });

  it('returns unavailable for empty parse', () => {
    const snap = parseClaudeUsageText('no usage data here');
    expect(snap.status).toBe('unavailable');
    expect(snap.buckets).toHaveLength(0);
  });
});
