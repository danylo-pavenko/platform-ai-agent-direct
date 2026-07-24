import { describe, expect, it } from 'vitest';
import { isUnusableClaudeResultText } from './claude-result-usable.js';

describe('isUnusableClaudeResultText', () => {
  it('flags empty and auth stubs', () => {
    expect(isUnusableClaudeResultText('')).toBe(true);
    expect(isUnusableClaudeResultText('Not logged in · Please run /login')).toBe(true);
    expect(isUnusableClaudeResultText('authentication_failed')).toBe(true);
  });

  it('accepts normal customer replies', () => {
    expect(isUnusableClaudeResultText('Привіт! Як можу допомогти?')).toBe(false);
  });
});
