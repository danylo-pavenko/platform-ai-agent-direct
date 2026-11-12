import { describe, expect, it } from 'vitest';
import { isUnusableClaudeResultText } from './claude-result-usable.js';

describe('isUnusableClaudeResultText', () => {
  it('flags empty/auth/session stubs and accepts real replies', () => {
    expect(isUnusableClaudeResultText('')).toBe(true);
    expect(isUnusableClaudeResultText('Not logged in · Please run /login')).toBe(true);
    expect(isUnusableClaudeResultText('authentication_failed')).toBe(true);
    expect(
      isUnusableClaudeResultText(
        "You've hit your session limit · resets 9am (Europe/Berlin)",
      ),
    ).toBe(true);
    expect(isUnusableClaudeResultText('Привіт! Як можу допомогти?')).toBe(false);
  });
});
