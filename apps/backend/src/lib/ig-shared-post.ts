/**
 * Instagram post/reel shares in DM.
 *
 * Meta now sends `ig_post` / `ig_reel` (legacy `share` is deprecated after
 * Feb 2026). Payload `url` is often a lookaside CDN image, not instagram.com/p/…
 */

export interface SharedPostData {
  /** Canonical instagram.com permalink when we have one. */
  postUrl?: string;
  /** CDN URL before persist, then local storage key. */
  imageUrl?: string;
  caption?: string;
  mediaId?: string;
  kind?: 'post' | 'reel';
  [key: string]: unknown;
}

export type MetaShareAttachment = {
  type?: string;
  payload?: unknown;
};

const IG_SHARE_TYPES = new Set(['share', 'ig_post', 'post', 'ig_reel', 'reel']);

const IG_PERMALINK_RE =
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

export function parseIgPermalink(text: string | null | undefined): {
  shortcode: string;
  kind: 'post' | 'reel';
  url: string;
} | null {
  if (!text) return null;
  const m = text.match(IG_PERMALINK_RE);
  if (!m?.[1] || !m[2]) return null;
  const kind: 'post' | 'reel' = /reel/i.test(m[1]) ? 'reel' : 'post';
  const path = kind === 'reel' ? 'reel' : 'p';
  return {
    shortcode: m[2],
    kind,
    url: `https://www.instagram.com/${path}/${m[2]}/`,
  };
}

export function isIgPermalinkUrl(url: string | null | undefined): boolean {
  return parseIgPermalink(url) != null;
}

export function isMessagingCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const path = new URL(url).pathname.toLowerCase();
    return (
      host.includes('lookaside.fbsbx.com') ||
      host.includes('cdninstagram.com') ||
      host.includes('fbcdn.net') ||
      host.startsWith('scontent') ||
      path.includes('ig_messaging_cdn')
    );
  } catch {
    return false;
  }
}

export function isShareAttachmentType(type: string | null | undefined): boolean {
  return IG_SHARE_TYPES.has((type ?? '').toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function payloadString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function payloadMediaId(payload: Record<string, unknown>): string | undefined {
  const named = payloadString(payload, ['ig_post_media_id', 'ig_reel_id']);
  if (named && /^\d{10,}$/.test(named)) return named;
  const id = payload.id;
  if (typeof id === 'number' && Number.isFinite(id) && id > 1e9) return String(id);
  if (typeof id === 'string' && /^\d{10,}$/.test(id.trim())) return id.trim();
  return undefined;
}

export function mergeSharedPost(
  base: SharedPostData | null | undefined,
  extra: SharedPostData | null | undefined,
): SharedPostData | null {
  if (!base) return extra && hasSharedPostContent(extra) ? { ...extra } : null;
  if (!extra) return hasSharedPostContent(base) ? { ...base } : null;
  const merged: SharedPostData = {
    kind: extra.kind ?? base.kind,
    postUrl:
      (isIgPermalinkUrl(extra.postUrl) ? extra.postUrl : undefined) ??
      (isIgPermalinkUrl(base.postUrl) ? base.postUrl : undefined) ??
      extra.postUrl ??
      base.postUrl,
    imageUrl: extra.imageUrl ?? base.imageUrl,
    caption: extra.caption ?? base.caption,
    mediaId: extra.mediaId ?? base.mediaId,
  };
  return hasSharedPostContent(merged) ? merged : null;
}

export function hasSharedPostContent(post: SharedPostData | null | undefined): boolean {
  if (!post) return false;
  return Boolean(
    post.postUrl?.trim() ||
      post.imageUrl?.trim() ||
      post.caption?.trim() ||
      post.mediaId?.trim(),
  );
}

export function parseStoredSharedPost(value: unknown): SharedPostData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const post = value as SharedPostData;
  return hasSharedPostContent(post) ? post : undefined;
}

function fromAttachment(att: MetaShareAttachment): SharedPostData | null {
  const type = (att.type ?? '').toLowerCase();
  const payload = asRecord(att.payload) ?? {};
  const rawUrl = payloadString(payload, ['url', 'link', 'permalink']);
  const permalink = rawUrl ? parseIgPermalink(rawUrl) : null;
  const isFallbackShare =
    (type === 'fallback' || type === 'template') && permalink != null;

  if (!isShareAttachmentType(type) && !isFallbackShare) return null;

  const caption = payloadString(payload, ['title', 'caption']);
  const mediaId = payloadMediaId(payload);
  const imageHint = payloadString(payload, [
    'image_url',
    'media_url',
    'thumbnail_url',
  ]);
  const kind: 'post' | 'reel' =
    type === 'ig_reel' || type === 'reel' || permalink?.kind === 'reel'
      ? 'reel'
      : 'post';

  const post: SharedPostData = { kind };
  if (caption) post.caption = caption;
  if (mediaId) post.mediaId = mediaId;
  if (permalink) post.postUrl = permalink.url;

  if (imageHint && (isMessagingCdnUrl(imageHint) || imageHint.startsWith('http'))) {
    post.imageUrl = imageHint;
  }
  if (!permalink && rawUrl && (isMessagingCdnUrl(rawUrl) || rawUrl.startsWith('https://'))) {
    post.imageUrl = post.imageUrl ?? rawUrl;
  }

  return hasSharedPostContent(post) ? post : null;
}

/** Parse share / ig_post / ig_reel / pasted permalink from a Meta message. */
export function extractSharedPostFromMetaMessage(message: {
  text?: string | null;
  attachments?: MetaShareAttachment[] | null;
}): SharedPostData | null {
  let found: SharedPostData | null = null;
  for (const att of message.attachments ?? []) {
    found = mergeSharedPost(found, fromAttachment(att));
  }
  const fromText = parseIgPermalink(message.text);
  if (fromText) {
    found = mergeSharedPost(found, {
      postUrl: fromText.url,
      kind: fromText.kind,
    });
  }
  return found;
}
