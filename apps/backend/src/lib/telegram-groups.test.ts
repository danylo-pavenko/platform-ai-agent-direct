import { describe, expect, it } from 'vitest';
import { isGroupChatType, mergeNotificationChatIds, filterChatIdsForAudience, isPrivateTelegramChatId } from './telegram-groups.js';

describe('isGroupChatType', () => {
  it('accepts group and supergroup', () => {
    expect(isGroupChatType('group')).toBe(true);
    expect(isGroupChatType('supergroup')).toBe(true);
  });

  it('rejects private and channel chats', () => {
    expect(isGroupChatType('private')).toBe(false);
    expect(isGroupChatType('channel')).toBe(false);
    expect(isGroupChatType(undefined)).toBe(false);
  });
});

describe('isPrivateTelegramChatId', () => {
  it('treats positive ids as private DMs', () => {
    expect(isPrivateTelegramChatId('987654321')).toBe(true);
  });

  it('treats negative ids as groups', () => {
    expect(isPrivateTelegramChatId('-100123')).toBe(false);
    expect(isPrivateTelegramChatId('-42')).toBe(false);
  });
});

describe('filterChatIdsForAudience', () => {
  const ids = ['-100123', '987654321', '-100456'];

  it('keeps all ids for all audience', () => {
    expect(filterChatIdsForAudience(ids, 'all')).toEqual(ids);
  });

  it('keeps only private DMs', () => {
    expect(filterChatIdsForAudience(ids, 'private')).toEqual(['987654321']);
  });

  it('keeps only groups', () => {
    expect(filterChatIdsForAudience(ids, 'groups')).toEqual(['-100123', '-100456']);
  });
});

describe('mergeNotificationChatIds', () => {
  it('merges groups and authorized private chats without duplicates', () => {
    expect(
      mergeNotificationChatIds({
        managerGroupId: '-100123',
        storedGroupIds: ['-100123', '-100456'],
        authorizedManagerChatIds: ['987654321', '-100456'],
      }),
    ).toEqual(['-100123', '-100456', '987654321']);
  });

  it('returns only authorized private chats when no groups configured', () => {
    expect(
      mergeNotificationChatIds({
        managerGroupId: '',
        storedGroupIds: [],
        authorizedManagerChatIds: ['123456789'],
      }),
    ).toEqual(['123456789']);
  });
});
