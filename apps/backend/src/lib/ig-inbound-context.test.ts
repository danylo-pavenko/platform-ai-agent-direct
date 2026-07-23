import { describe, expect, it } from 'vitest';
import {
  buildIgInboundContextHeader,
  enrichUserMessageWithIgContext,
  reactionDisplay,
} from './ig-inbound-context.js';

describe('reactionDisplay', () => {
  it('prefers explicit emoji', () => {
    expect(reactionDisplay('love', '💖')).toBe('💖');
  });

  it('maps named reactions', () => {
    expect(reactionDisplay('love')).toBe('❤️');
    expect(reactionDisplay('laugh')).toBe('😆');
  });
});

describe('buildIgInboundContextHeader', () => {
  it('labels story replies for warm engagement', () => {
    const header = buildIgInboundContextHeader({
      kind: 'story_reply',
      story: { id: 's1', url: 'https://cdn.example/story.jpg' },
    });
    expect(header).toContain('відповів на вашу Instagram Stories');
    expect(header).toContain('тепло');
  });

  it('labels reactions with target snippet', () => {
    const header = buildIgInboundContextHeader({
      kind: 'reaction',
      reaction: {
        targetMid: 'm1',
        action: 'react',
        reaction: 'love',
        emoji: '❤️',
        targetSnippet: 'Ось худі з принтом',
      },
    });
    expect(header).toContain('реакцію ❤️');
    expect(header).toContain('Ось худі з принтом');
  });
});

describe('enrichUserMessageWithIgContext', () => {
  it('wraps client text under story reply header', () => {
    const out = enrichUserMessageWithIgContext('Де купити?', {
      kind: 'story_reply',
      story: { id: 's1' },
    });
    expect(out).toContain('Stories');
    expect(out).toContain('Де купити?');
  });

  it('synthesizes text for empty reaction turns', () => {
    const out = enrichUserMessageWithIgContext('', {
      kind: 'reaction',
      reaction: { targetMid: 'm1', action: 'react', reaction: 'like' },
    });
    expect(out).toContain('реакцію');
  });
});
