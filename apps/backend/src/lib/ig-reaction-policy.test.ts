import { describe, expect, it } from 'vitest';
import {
  isLikeOrHeartReaction,
  isSyntheticReactionText,
  shouldCancelFollowUpOnReaction,
  shouldScheduleBotTurnForReaction,
} from './ig-reaction-policy.js';

describe('isLikeOrHeartReaction', () => {
  it('treats Meta like/love and heart/thumb emojis as likes', () => {
    expect(isLikeOrHeartReaction('like')).toBe(true);
    expect(isLikeOrHeartReaction('love')).toBe(true);
    expect(isLikeOrHeartReaction(undefined, '❤️')).toBe(true);
    expect(isLikeOrHeartReaction(undefined, '🖤')).toBe(true);
    expect(isLikeOrHeartReaction(undefined, '👍')).toBe(true);
  });

  it('does not treat wow/sad/angry as likes', () => {
    expect(isLikeOrHeartReaction('wow', '😮')).toBe(false);
    expect(isLikeOrHeartReaction('sad')).toBe(false);
    expect(isLikeOrHeartReaction('angry')).toBe(false);
  });
});

describe('isSyntheticReactionText', () => {
  it('matches persisted reaction bubbles', () => {
    expect(isSyntheticReactionText('Реакція ❤️')).toBe(true);
    expect(isSyntheticReactionText('реакція 👍')).toBe(true);
    expect(isSyntheticReactionText('Дякую')).toBe(false);
  });
});

describe('reaction bot-turn policy', () => {
  it('never schedules a Claude turn for a reaction-only event', () => {
    expect(shouldScheduleBotTurnForReaction()).toBe(false);
  });

  it('does not cancel remarketing because of a like', () => {
    expect(shouldCancelFollowUpOnReaction('love', '❤️')).toBe(false);
  });
});
