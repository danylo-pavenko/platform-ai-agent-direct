export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type ChangePasswordValidationError =
  | 'current_password_required'
  | 'new_password_required'
  | 'confirm_password_required'
  | 'password_mismatch'
  | 'password_too_short'
  | 'same_as_current';

export function validateChangePasswordInput(
  input: ChangePasswordInput,
  minLength = MIN_ADMIN_PASSWORD_LENGTH,
): ChangePasswordValidationError | null {
  const current = input.currentPassword?.trim() ?? '';
  const next = input.newPassword ?? '';
  const confirm = input.confirmPassword ?? '';

  if (!current) return 'current_password_required';
  if (!next) return 'new_password_required';
  if (!confirm) return 'confirm_password_required';
  if (next !== confirm) return 'password_mismatch';
  if (next.length < minLength) return 'password_too_short';
  if (next === current) return 'same_as_current';
  return null;
}

export const CHANGE_PASSWORD_ERROR_UK: Record<ChangePasswordValidationError, string> = {
  current_password_required: 'Вкажіть поточний пароль',
  new_password_required: 'Вкажіть новий пароль',
  confirm_password_required: 'Підтвердіть новий пароль',
  password_mismatch: 'Новий пароль і підтвердження не збігаються',
  password_too_short: `Новий пароль має містити щонайменше ${MIN_ADMIN_PASSWORD_LENGTH} символів`,
  same_as_current: 'Новий пароль має відрізнятися від поточного',
};
