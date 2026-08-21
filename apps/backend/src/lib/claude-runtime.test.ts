import { describe, expect, it } from 'vitest';
import {
  ADMIN_FALLBACK_BUSY,
  ADMIN_FALLBACK_TIMEOUT,
  CLAUDE_SDK_DISALLOWED_TOOLS,
  claudeConcurrencyLane,
  claudeFallbackResponse,
  claudeTimeoutMs,
  parseClaudeRuntimeKind,
} from './claude-runtime.js';
import {
  CUSTOMER_FALLBACK_BUSY,
  CUSTOMER_FALLBACK_TIMEOUT,
} from './agent-fallback-defaults.js';

describe('parseClaudeRuntimeKind', () => {
  it('accepts cli and sdk', () => {
    expect(parseClaudeRuntimeKind('cli')).toBe('cli');
    expect(parseClaudeRuntimeKind('sdk')).toBe('sdk');
  });

  it('defaults unknown / empty values to sdk (Phase 5 prod default)', () => {
    expect(parseClaudeRuntimeKind(undefined)).toBe('sdk');
    expect(parseClaudeRuntimeKind(null)).toBe('sdk');
    expect(parseClaudeRuntimeKind('')).toBe('sdk');
    expect(parseClaudeRuntimeKind('CLI')).toBe('sdk');
    expect(parseClaudeRuntimeKind('messages-api')).toBe('sdk');
  });
});

describe('claudeFallbackResponse', () => {
  it('uses customer copy for Instagram / Telegram', () => {
    expect(claudeFallbackResponse('busy', { channel: 'instagram' }).text).toBe(
      CUSTOMER_FALLBACK_BUSY,
    );
    expect(claudeFallbackResponse('timeout', { channel: 'telegram' }).text).toBe(
      CUSTOMER_FALLBACK_TIMEOUT,
    );
  });

  it('uses technical copy for admin channels', () => {
    expect(claudeFallbackResponse('busy', { channel: 'sandbox' }).text).toBe(ADMIN_FALLBACK_BUSY);
    expect(claudeFallbackResponse('timeout', { channel: 'meta_agent' }).text).toBe(
      ADMIN_FALLBACK_TIMEOUT,
    );
    expect(claudeFallbackResponse('timeout', { channel: 'insights' }).fallback).toBe('timeout');
  });

  it('attaches errorDetail when provided', () => {
    const r = claudeFallbackResponse('timeout', { channel: 'instagram' }, 'quota_gate: x');
    expect(r.errorDetail).toBe('quota_gate: x');
    expect(r.fallback).toBe('timeout');
  });
});

describe('claudeTimeoutMs', () => {
  const defaults = { adminMs: 120_000, customerMs: 60_000 };

  it('prefers per-call override', () => {
    expect(
      claudeTimeoutMs({ channel: 'instagram', timeoutMs: 9_000 }, defaults),
    ).toBe(9_000);
  });

  it('uses admin timeout for teach / sandbox', () => {
    expect(claudeTimeoutMs({ channel: 'meta_agent' }, defaults)).toBe(120_000);
  });

  it('uses customer timeout for IG', () => {
    expect(claudeTimeoutMs({ channel: 'instagram' }, defaults)).toBe(60_000);
  });
});

describe('claudeConcurrencyLane', () => {
  it('isolates meta-agent from the shared IG/sandbox lane', () => {
    expect(claudeConcurrencyLane('meta_agent')).toBe('meta');
    expect(claudeConcurrencyLane('instagram')).toBe('shared');
    expect(claudeConcurrencyLane('sandbox')).toBe('shared');
    expect(claudeConcurrencyLane(undefined)).toBe('shared');
  });
});

describe('CLAUDE_SDK_DISALLOWED_TOOLS', () => {
  it('locks down coding-agent filesystem tools', () => {
    expect(CLAUDE_SDK_DISALLOWED_TOOLS).toEqual([
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
    ]);
  });
});
