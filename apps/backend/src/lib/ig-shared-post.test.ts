import { describe, expect, it } from 'vitest';
import {
  extractSharedPostFromMetaMessage,
  isIgPermalinkUrl,
  isMessagingCdnUrl,
  isShareAttachmentType,
  parseIgPermalink,
  parseStoredSharedPost,
} from './ig-shared-post.js';

describe('parseIgPermalink', () => {
  it('canonicalizes feed posts', () => {
    expect(parseIgPermalink('https://www.instagram.com/p/DaPOcr7CLoR/?img_index=1')).toEqual({
      shortcode: 'DaPOcr7CLoR',
      kind: 'post',
      url: 'https://www.instagram.com/p/DaPOcr7CLoR/',
    });
  });

  it('parses reels and URLs inside surrounding text', () => {
    const parsed = parseIgPermalink('Дивись https://instagram.com/reel/AbC123_-xy/ будь ласка');
    expect(parsed?.kind).toBe('reel');
    expect(parsed?.url).toBe('https://www.instagram.com/reel/AbC123_-xy/');
  });
});

describe('extractSharedPostFromMetaMessage', () => {
  it('reads modern ig_post (CDN url + media id + caption)', () => {
    const post = extractSharedPostFromMetaMessage({
      attachments: [
        {
          type: 'ig_post',
          payload: {
            ig_post_media_id: '18139494541428835',
            title: 'Різні дизайни, але одна історія',
            url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835',
          },
        },
      ],
    });
    expect(post?.mediaId).toBe('18139494541428835');
    expect(post?.caption).toContain('Різні дизайни');
    expect(post?.imageUrl).toContain('lookaside.fbsbx.com');
    expect(post?.postUrl).toBeUndefined();
  });

  it('prefers permalink from text over CDN-only share url', () => {
    const post = extractSharedPostFromMetaMessage({
      text: 'https://www.instagram.com/p/DaPOcr7CLoR/',
      attachments: [
        {
          type: 'share',
          payload: {
            url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1',
            title: 'caption',
          },
        },
      ],
    });
    expect(post?.postUrl).toBe('https://www.instagram.com/p/DaPOcr7CLoR/');
    expect(post?.imageUrl).toContain('lookaside');
    expect(post?.caption).toBe('caption');
  });

  it('treats fallback attachment with IG permalink as a share', () => {
    const post = extractSharedPostFromMetaMessage({
      attachments: [
        {
          type: 'fallback',
          payload: { url: 'https://www.instagram.com/p/DaPOcr7CLoR/', title: 'Post' },
        },
      ],
    });
    expect(post?.postUrl).toBe('https://www.instagram.com/p/DaPOcr7CLoR/');
  });

  it('does not treat a tel: fallback as a shared post', () => {
    expect(
      extractSharedPostFromMetaMessage({
        attachments: [{ type: 'fallback', payload: { url: 'tel:+380979931530' } }],
      }),
    ).toBeNull();
  });

  it('reads both share and ig_post in the dual-type payload', () => {
    const post = extractSharedPostFromMetaMessage({
      attachments: [
        {
          type: 'share',
          payload: {
            ig_post_media_id: '18139494541428835',
            title: 'Build a workspace',
            url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835',
          },
        },
        {
          type: 'ig_post',
          payload: {
            ig_post_media_id: '18139494541428835',
            title: 'Build a workspace',
            url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835',
          },
        },
      ],
    });
    expect(post?.mediaId).toBe('18139494541428835');
    expect(isShareAttachmentType('ig_post')).toBe(true);
  });
});

describe('url helpers', () => {
  it('detects messaging CDN vs permalink', () => {
    expect(
      isMessagingCdnUrl(
        'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1',
      ),
    ).toBe(true);
    expect(isIgPermalinkUrl('https://www.instagram.com/p/DaPOcr7CLoR/')).toBe(true);
    expect(isIgPermalinkUrl('https://lookaside.fbsbx.com/x')).toBe(false);
  });

  it('parses stored JSONB', () => {
    expect(parseStoredSharedPost({ postUrl: 'https://www.instagram.com/p/x/' })?.postUrl).toContain(
      '/p/x/',
    );
    expect(parseStoredSharedPost({})).toBeUndefined();
  });
});
