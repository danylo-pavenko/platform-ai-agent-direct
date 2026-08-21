import { describe, expect, it } from 'vitest';
import { CLAUDE_SDK_DISALLOWED_TOOLS } from './claude-runtime.js';
import {
  CLAUDE_SDK_CLIENT_APP,
  CLAUDE_SDK_LOCKDOWN,
  buildClaudeSdkQueryOptions,
  sdkOptionsExposeCodingTools,
} from './claude-sdk-options.js';

describe('CLAUDE_SDK_LOCKDOWN', () => {
  it('disables every built-in coding tool', () => {
    expect(CLAUDE_SDK_LOCKDOWN.tools).toEqual([]);
    expect(CLAUDE_SDK_LOCKDOWN.allowedTools).toEqual([]);
    expect(CLAUDE_SDK_LOCKDOWN.permissionMode).toBe('dontAsk');
    expect(CLAUDE_SDK_LOCKDOWN.settingSources).toEqual([]);
    expect(CLAUDE_SDK_LOCKDOWN.maxTurns).toBe(1);
    expect(CLAUDE_SDK_LOCKDOWN.disallowedTools).toEqual([...CLAUDE_SDK_DISALLOWED_TOOLS]);
    expect(sdkOptionsExposeCodingTools(CLAUDE_SDK_LOCKDOWN)).toBe(false);
  });

  it('treats missing/preset tools as exposing coding tools', () => {
    expect(sdkOptionsExposeCodingTools({})).toBe(true);
    expect(sdkOptionsExposeCodingTools({ tools: { type: 'preset', preset: 'claude_code' } })).toBe(
      true,
    );
    expect(sdkOptionsExposeCodingTools({ tools: ['Bash'] })).toBe(true);
    expect(sdkOptionsExposeCodingTools({ tools: [], allowedTools: ['Read'] })).toBe(true);
  });
});

describe('buildClaudeSdkQueryOptions', () => {
  it('snapshots lockdown + session fields', () => {
    const abortController = new AbortController();
    const options = buildClaudeSdkQueryOptions({
      model: 'sonnet',
      cwd: '/tmp/claude-spawn',
      systemPrompt: 'You are a salon agent.',
      resumeSessionId: 'sess-1',
      abortController,
      includePartialMessages: true,
      timeoutMs: 12_000,
      env: { PATH: '/usr/bin', HOME: '/home/t' },
    });

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual([...CLAUDE_SDK_DISALLOWED_TOOLS]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.model).toBe('sonnet');
    expect(options.cwd).toBe('/tmp/claude-spawn');
    expect(options.systemPrompt).toBe('You are a salon agent.');
    expect(options.resume).toBe('sess-1');
    expect(options.abortController).toBe(abortController);
    expect(options.includePartialMessages).toBe(true);
    expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(CLAUDE_SDK_CLIENT_APP);
    expect(options.env?.API_TIMEOUT_MS).toBe('12000');
    expect(options.env?.PATH).toBe('/usr/bin');
    expect(sdkOptionsExposeCodingTools(options)).toBe(false);
  });

  it('omits resume when no session id', () => {
    const options = buildClaudeSdkQueryOptions({
      model: 'haiku',
      cwd: '/tmp',
      systemPrompt: 'sys',
      abortController: new AbortController(),
      includePartialMessages: false,
      timeoutMs: 1000,
      env: {},
    });
    expect(options.resume).toBeUndefined();
  });

  it('lists only MCP lookup names when lookups are enabled', () => {
    const options = buildClaudeSdkQueryOptions({
      model: 'sonnet',
      cwd: '/tmp',
      systemPrompt: 'sys',
      abortController: new AbortController(),
      includePartialMessages: false,
      timeoutMs: 1000,
      env: {},
      mcpAllowedTools: ['mcp__platform__search_services'],
    });
    expect(options.tools).toEqual(['mcp__platform__search_services']);
    expect(options.allowedTools).toEqual(['mcp__platform__search_services']);
    expect(sdkOptionsExposeCodingTools(options)).toBe(false);
  });
});
