import { describe, expect, it } from 'vitest';
import {
  formatAdminLabel,
  generateManagerUsername,
  generateTelegramLinkCode,
  toAdminUserPublic,
  toAssignee,
} from './admin-user.js';

describe('formatAdminLabel', () => {
  it('prefers displayName', () => {
    expect(
      formatAdminLabel({
        displayName: 'Оля',
        tgUsername: 'olya_tg',
        username: 'manager_abc',
      }),
    ).toBe('Оля');
  });

  it('falls back to @tgUsername', () => {
    expect(
      formatAdminLabel({
        displayName: null,
        tgUsername: 'olya_tg',
        username: 'manager_abc',
      }),
    ).toBe('@olya_tg');
  });

  it('falls back to username', () => {
    expect(
      formatAdminLabel({
        displayName: '  ',
        tgUsername: null,
        username: 'manager_abc',
      }),
    ).toBe('manager_abc');
  });
});

describe('toAdminUserPublic / toAssignee', () => {
  it('maps fields safely', () => {
    const pub = toAdminUserPublic({
      id: 'u1',
      username: 'manager_1',
      role: 'manager',
      displayName: 'Іра',
      tgUserId: '123',
      tgUsername: 'ira',
      isActive: true,
    });
    expect(pub).toEqual({
      id: 'u1',
      username: 'manager_1',
      role: 'manager',
      displayName: 'Іра',
      tgUserId: '123',
      tgUsername: 'ira',
      isActive: true,
    });
    expect(toAssignee(pub)).toEqual({
      id: 'u1',
      displayName: 'Іра',
      username: 'manager_1',
      tgUsername: 'ira',
    });
  });

  it('defaults isActive to true when missing', () => {
    expect(
      toAdminUserPublic({
        id: 'u1',
        username: 'admin',
        role: 'owner',
      }).isActive,
    ).toBe(true);
  });
});

describe('generators', () => {
  it('generateManagerUsername has prefix', () => {
    expect(generateManagerUsername()).toMatch(/^manager_[a-f0-9]{8}$/);
  });

  it('generateTelegramLinkCode is uppercase alphanumeric without ambiguous chars', () => {
    const code = generateTelegramLinkCode(8);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    expect(code).not.toMatch(/[01OI]/);
  });
});
