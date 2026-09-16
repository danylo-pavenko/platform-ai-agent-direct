/**
 * Resolve IG share preview: Graph media id / oEmbed permalink, then download
 * the image before the messaging CDN URL expires.
 */

import pino from 'pino';
import { getIntegrationConfig } from '../lib/integration-config.js';
import {
  extractSharedPostFromMetaMessage,
  isIgPermalinkUrl,
  type SharedPostData,
} from '../lib/ig-shared-post.js';
import {
  isRemoteMediaUrl,
  persistIncomingMediaItems,
} from './media.js';
import type { StoredMediaAttachment } from '../lib/media-attachments.js';

const log = pino({ name: 'ig-shared-post-media' });
const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const FETCH_MS = 5_000;

type GraphMedia = {
  permalink?: string;
  caption?: string;
  media_url?: string;
  thumbnail_url?: string;
  media_type?: string;
};

async function graphJson(
  url: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.debug({ status: res.status, url }, 'IG share Graph lookup non-OK');
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    log.debug({ err, url }, 'IG share Graph lookup failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchByMediaId(mediaId: string, token: string): Promise<GraphMedia | null> {
  const url = new URL(`${FB_GRAPH_BASE}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set(
    'fields',
    'permalink,caption,media_url,thumbnail_url,media_type,shortcode',
  );
  const json = await graphJson(url.toString(), token);
  if (!json) return null;
  return {
    permalink: typeof json.permalink === 'string' ? json.permalink : undefined,
    caption: typeof json.caption === 'string' ? json.caption : undefined,
    media_url: typeof json.media_url === 'string' ? json.media_url : undefined,
    thumbnail_url: typeof json.thumbnail_url === 'string' ? json.thumbnail_url : undefined,
    media_type: typeof json.media_type === 'string' ? json.media_type : undefined,
  };
}

async function fetchOembed(permalink: string, token: string): Promise<GraphMedia | null> {
  const url = new URL(`${FB_GRAPH_BASE}/instagram_oembed`);
  url.searchParams.set('url', permalink);
  url.searchParams.set('access_token', token);
  const json = await graphJson(url.toString(), token);
  if (!json) return null;
  return {
    thumbnail_url:
      typeof json.thumbnail_url === 'string' ? json.thumbnail_url : undefined,
    caption: typeof json.title === 'string' ? json.title : undefined,
  };
}

function firstHttp(...urls: Array<string | undefined>): string | undefined {
  return urls.find((u) => typeof u === 'string' && isRemoteMediaUrl(u));
}

function graphAttachmentsToMeta(
  json: Record<string, unknown>,
): { text?: string; attachments: Array<{ type?: string; payload?: unknown }> } {
  const text = typeof json.message === 'string' ? json.message : undefined;
  const raw = json.attachments;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data)
      : [];
  const attachments = list.map((item) => {
    if (!item || typeof item !== 'object') return { type: undefined, payload: undefined };
    const row = item as Record<string, unknown>;
    const payload =
      row.payload && typeof row.payload === 'object'
        ? { ...(row.payload as Record<string, unknown>) }
        : {};
    if (typeof row.url === 'string' && !payload.url) payload.url = row.url;
    if (typeof row.title === 'string' && !payload.title) payload.title = row.title;
    const imageData = row.image_data;
    if (imageData && typeof imageData === 'object') {
      const img = imageData as Record<string, unknown>;
      if (typeof img.url === 'string' && !payload.image_url) payload.image_url = img.url;
      if (typeof img.preview_url === 'string' && !payload.image_url) {
        payload.image_url = img.preview_url;
      }
    }
    return { type: typeof row.type === 'string' ? row.type : undefined, payload };
  });
  return { text, attachments };
}

/** When the webhook only has is_unsupported, Graph often still has the share. */
export async function fetchSharedPostFromGraphMessage(
  mid: string,
): Promise<SharedPostData | null> {
  const { meta } = await getIntegrationConfig();
  const token = meta.pageAccessToken?.trim();
  if (!token || !mid.trim()) return null;
  const url = new URL(`${FB_GRAPH_BASE}/${encodeURIComponent(mid.trim())}`);
  url.searchParams.set('fields', 'message,attachments{type,payload,title,url,image_data}');
  const json = await graphJson(url.toString(), token);
  if (!json) return null;
  return extractSharedPostFromMetaMessage(graphAttachmentsToMeta(json));
}

export async function enrichAndPersistSharedPost(post: SharedPostData): Promise<{
  post: SharedPostData;
  attachments: StoredMediaAttachment[];
}> {
  let next: SharedPostData = { ...post };
  const { meta } = await getIntegrationConfig();
  const token = meta.pageAccessToken?.trim();

  if (token && next.mediaId) {
    const graph = await fetchByMediaId(next.mediaId, token);
    if (graph) {
      if (graph.permalink && isIgPermalinkUrl(graph.permalink)) {
        next.postUrl = graph.permalink;
      }
      if (graph.caption && !next.caption) next.caption = graph.caption;
      next.imageUrl =
        firstHttp(graph.thumbnail_url, graph.media_url, next.imageUrl) ?? next.imageUrl;
    }
  }

  if (token && next.postUrl && isIgPermalinkUrl(next.postUrl) && !next.imageUrl) {
    const oembed = await fetchOembed(next.postUrl, token);
    if (oembed?.thumbnail_url) next.imageUrl = oembed.thumbnail_url;
    if (oembed?.caption && !next.caption) next.caption = oembed.caption;
  }

  const attachments: StoredMediaAttachment[] = [];
  if (next.imageUrl && isRemoteMediaUrl(next.imageUrl)) {
    const [shareImage] = await persistIncomingMediaItems([
      { url: next.imageUrl, igType: 'share_image' },
    ]);
    if (shareImage) {
      attachments.push(shareImage);
      if (shareImage.status === 'ready' && shareImage.storageKey) {
        next = { ...next, imageUrl: shareImage.storageKey };
      }
    }
  }

  log.info(
    {
      hasPermalink: Boolean(next.postUrl && isIgPermalinkUrl(next.postUrl)),
      hasCaption: Boolean(next.caption),
      mediaId: next.mediaId ?? null,
      persisted: attachments[0]?.status ?? null,
    },
    'Shared Instagram post enriched',
  );

  return { post: next, attachments };
}
