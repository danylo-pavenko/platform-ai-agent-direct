import { describe, expect, it } from 'vitest';
import { visualStorageKeys } from './media-attachments.js';

describe('visualStorageKeys', () => {
  it('returns only image and video storage keys', () => {
    const keys = visualStorageKeys(
      [
        { kind: 'audio', igType: 'audio', status: 'ready', storageKey: 'a.m4a' },
        { kind: 'image', igType: 'image', status: 'ready', storageKey: 'b.jpg' },
        { kind: 'video', igType: 'video', status: 'ready', storageKey: 'c.mp4' },
      ],
      [],
    );
    expect(keys).toEqual(['b.jpg', 'c.mp4']);
  });

  it('infers kind from legacy mediaUrls extensions', () => {
    expect(visualStorageKeys(undefined, ['x.m4a', 'y.webp'])).toEqual(['y.webp']);
  });
});
