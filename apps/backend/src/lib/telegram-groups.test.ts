import { describe, expect, it } from 'vitest';
import { isGroupChatType } from './telegram-groups.js';

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
