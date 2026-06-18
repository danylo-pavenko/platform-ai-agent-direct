import { describe, expect, it } from 'vitest';
import { extractClaudeAuthUrl } from './claude-auth.js';

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
