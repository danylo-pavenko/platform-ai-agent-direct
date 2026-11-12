import { describe, expect, it } from 'vitest';
import {
  signLibraryAssetToken,
  verifyLibraryAssetToken,
} from './library-assets.js';

describe('library asset signed URL token', () => {
  it('round-trips a valid signature', () => {
    const articleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const attachmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const token = signLibraryAssetToken(articleId, attachmentId);
    expect(verifyLibraryAssetToken(articleId, attachmentId, token)).toBe(true);
    expect(verifyLibraryAssetToken(articleId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', token)).toBe(
      false,
    );
  });

  it('rejects expired tokens', () => {
    const articleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const attachmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const expired = signLibraryAssetToken(articleId, attachmentId, 1);
    expect(verifyLibraryAssetToken(articleId, attachmentId, expired)).toBe(false);
  });
});
