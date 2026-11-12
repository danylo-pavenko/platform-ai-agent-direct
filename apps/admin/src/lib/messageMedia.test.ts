import { describe, expect, it } from 'vitest';
import {
  getMessageMediaItems,
  isIgMediaPlaceholderText,
} from './messageMedia';

const LOOKASIDE =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2262122501354650&signature=Ab2TQOoe';

describe('getMessageMediaItems · Meta messaging CDN', () => {
  it('treats lookaside.fbsbx.com asset URLs as playable images', () => {
    const items = getMessageMediaItems({ mediaUrls: [LOOKASIDE, LOOKASIDE] });
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('image');
    expect(items[0]?.playable).toBe(true);
    expect(items[0]?.src).toBe(LOOKASIDE);
  });

  it('still infers extension-based kinds', () => {
    expect(getMessageMediaItems({ mediaUrls: ['uploads/a.jpg'] })[0]?.kind).toBe('image');
    expect(getMessageMediaItems({ mediaUrls: ['uploads/a.mp4'] })[0]?.kind).toBe('video');
  });
});

describe('isIgMediaPlaceholderText', () => {
  it('matches echo placeholders', () => {
    expect(isIgMediaPlaceholderText('[медіа Instagram]')).toBe(true);
    expect(isIgMediaPlaceholderText('Надсилаємо сітку')).toBe(false);
  });
});
