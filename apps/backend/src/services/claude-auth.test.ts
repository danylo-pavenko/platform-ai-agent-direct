import { describe, expect, it } from 'vitest';
import { extractClaudeAuthUrl } from './claude-auth.js';
import { isClaudeAuthFailure } from './claude.js';

describe('extractClaudeAuthUrl', () => {
  it('extracts claude.ai oauth URL from CLI output', () => {
    const text =
      'Opening browser...\nIf browser does not open, visit:\nhttps://claude.ai/oauth/authorize?code=abc123&state=xyz\n';
    expect(extractClaudeAuthUrl(text)).toBe(
      'https://claude.ai/oauth/authorize?code=abc123&state=xyz',
    );
  });

  it('extracts console.anthropic.com URL', () => {
    const text = 'Go to https://console.anthropic.com/oauth/authorize?foo=bar) now';
    expect(extractClaudeAuthUrl(text)).toBe(
      'https://console.anthropic.com/oauth/authorize?foo=bar',
    );
  });

  it('returns null when no URL present', () => {
    expect(extractClaudeAuthUrl('not logged in')).toBeNull();
  });
});

describe('isClaudeAuthFailure', () => {
  it('detects 401 invalid authentication', () => {
    expect(
      isClaudeAuthFailure('API Error: 401 Invalid authentication credentials'),
    ).toBe(true);
    expect(isClaudeAuthFailure('Please run /login')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isClaudeAuthFailure('timeout after 12000ms')).toBe(false);
  });
});

describe('buildClaudeAuthPromptBlock', () => {
  it('includes logged-in snapshot fields', async () => {
    const { buildClaudeAuthPromptBlock } = await import('./claude-auth.js');
    const block = buildClaudeAuthPromptBlock({
      binaryOk: true,
      binaryPath: '/home/tkp/.local/bin/claude',
      binaryVersion: '2.1.181',
      loggedIn: true,
      sessionExpired: false,
      authMethod: 'oauth',
      email: 'user@example.com',
      subscriptionType: 'pro',
      orgName: null,
      error: null,
      loginInProgress: false,
    });
    expect(block).toContain('<claude_runtime>');
    expect(block).toContain('"loggedIn": true');
    expect(block).toContain('user@example.com');
  });
});
