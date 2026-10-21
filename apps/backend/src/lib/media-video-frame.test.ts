import { describe, expect, it } from 'vitest';
import { isVideoContentType } from './media-video-frame.js';

describe('isVideoContentType', () => {
  it('detects video MIME types', () => {
    expect(isVideoContentType('video/mp4')).toBe(true);
    expect(isVideoContentType('video/quicktime; codecs=avc1')).toBe(true);
    expect(isVideoContentType('image/jpeg')).toBe(false);
    expect(isVideoContentType(null)).toBe(false);
  });
});
