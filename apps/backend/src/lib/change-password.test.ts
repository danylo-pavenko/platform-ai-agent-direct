import { describe, expect, it } from 'vitest';
import {
  MIN_ADMIN_PASSWORD_LENGTH,
  validateChangePasswordInput,
} from './change-password.js';

describe('validateChangePasswordInput', () => {
  const valid = {
    currentPassword: 'old-password-12',
    newPassword: 'new-password-12',
    confirmPassword: 'new-password-12',
  };

  it('accepts valid input', () => {
    expect(validateChangePasswordInput(valid)).toBeNull();
  });

  it('rejects empty current password', () => {
    expect(
      validateChangePasswordInput({ ...valid, currentPassword: '  ' }),
    ).toBe('current_password_required');
  });

  it('rejects mismatch', () => {
    expect(
      validateChangePasswordInput({ ...valid, confirmPassword: 'other-password' }),
    ).toBe('password_mismatch');
  });

  it('rejects short password', () => {
    expect(
      validateChangePasswordInput({
        ...valid,
        newPassword: 'short',
        confirmPassword: 'short',
      }),
    ).toBe('password_too_short');
  });

  it('rejects same as current', () => {
    expect(
      validateChangePasswordInput({
        ...valid,
        newPassword: valid.currentPassword,
        confirmPassword: valid.currentPassword,
      }),
    ).toBe('same_as_current');
  });

  it('uses configured minimum length', () => {
    const pwd = 'a'.repeat(MIN_ADMIN_PASSWORD_LENGTH);
    expect(
      validateChangePasswordInput(
        { currentPassword: 'old', newPassword: pwd, confirmPassword: pwd },
        MIN_ADMIN_PASSWORD_LENGTH,
      ),
    ).toBeNull();
  });
});
