import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve, relative, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { config } from '../config.js';
import {
  igTypeToMediaKind,
  type MediaKind,
  type StoredMediaAttachment,
} from '../lib/media-attachments.js';

const log = pino({ name: 'media' });

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/x-m4a': '.m4a',
};

/** Fallback extension when CDN omits Content-Type (common for IG voice notes). */
const IG_TYPE_EXT_HINT: Record<string, string> = {
  audio: '.m4a',
  video: '.mp4',
  image: '.jpg',
  sticker: '.jpg',
  file: '.bin',
};

export const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function mimeForStorageKey(storageKey: string): string {
  const dot = storageKey.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[storageKey.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function pickExtension(contentType: string, igType?: string): string {
  if (contentType && CONTENT_TYPE_TO_EXT[contentType]) {
    return CONTENT_TYPE_TO_EXT[contentType];
  }
  if (igType && IG_TYPE_EXT_HINT[igType]) {
    return IG_TYPE_EXT_HINT[igType];
  }
  return '.bin';
}

function uploadsRoot(): string {
  return resolve(config.UPLOADS_DIR);
}

/** Relative path under UPLOADS_DIR (stored in DB), e.g. `2026/06/uuid.jpg`. */
export function toStorageKey(absolutePath: string): string {
  const root = uploadsRoot();
  const rel = relative(root, resolve(absolutePath));
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('Path is outside uploads directory');
  }
  return rel.split(sep).join('/');
}

/** Resolve a DB storage key to an absolute file path (path-traversal safe). */
export function resolveStorageKey(storageKey: string): string {
  const normalized = normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = resolve(uploadsRoot(), normalized);
  const root = uploadsRoot();
  if (!abs.startsWith(root + sep) && abs !== root) {
    throw new Error('Invalid media storage key');
  }
  return abs;
}

export function isRemoteMediaUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Download a single media file from URL to local storage.
 * Instagram CDN URLs expire within minutes, so this should be called promptly.
 *
 * @returns Storage key (relative path) on success, null on failure.
 */
export async function downloadMedia(
  url: string,
  options?: { igType?: string },
): Promise<{ storageKey: string; contentType: string; kind: MediaKind } | null> {
  const igType = options?.igType ?? 'unknown';
  const kind = igTypeToMediaKind(igType);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      log.warn(
        { status: response.status, url, igType, kind },
        'Media download failed: non-OK status',
      );
      return null;
    }

    if (!response.body) {
      log.warn({ url, igType, kind }, 'Media download failed: empty response body');
      return null;
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    const ext = pickExtension(contentType, igType);

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const filename = `${randomUUID()}${ext}`;

    const dir = join(uploadsRoot(), yyyy, mm);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, filename);

    const readable = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const writable = createWriteStream(filePath);
    await pipeline(readable, writable);

    const fileStat = await stat(filePath);
    const storageKey = toStorageKey(filePath);
    log.info(
      { storageKey, size: fileStat.size, contentType, ext, igType, kind },
      `Media downloaded: ${fileStat.size} bytes`,
    );

    return { storageKey, contentType: contentType || mimeForStorageKey(storageKey), kind };
  } catch (err) {
    log.error({ err, url, igType, kind }, 'Media download failed');
    return null;
  }
}

export interface IncomingMediaItem {
  url: string;
  igType: string;
}

/**
 * Download IG CDN attachments and return structured records (includes failures).
 */
export async function persistIncomingMediaItems(
  items: IncomingMediaItem[],
): Promise<StoredMediaAttachment[]> {
  const results: StoredMediaAttachment[] = [];

  for (const item of items) {
    const kind = igTypeToMediaKind(item.igType);
    const downloaded = await downloadMedia(item.url, { igType: item.igType });

    if (downloaded) {
      results.push({
        kind: downloaded.kind,
        igType: item.igType,
        status: 'ready',
        storageKey: downloaded.storageKey,
      });
      continue;
    }

    results.push({
      kind,
      igType: item.igType,
      status: 'unavailable',
      reason: 'download_failed',
    });
  }

  return results;
}

/**
 * Download remote URLs and return storage keys in the same order (null = failed).
 */
export async function persistRemoteMediaUrls(urls: string[]): Promise<(string | null)[]> {
  const results = await Promise.all(
    urls.map((url) => downloadMedia(url).then((r) => r?.storageKey ?? null)),
  );
  return results;
}

/**
 * Resolve visual media (image/video) for Claude vision. Audio/file keys are excluded.
 */
export async function resolveVisualMediaPathsForClaude(
  visualKeys: string[],
): Promise<string[]> {
  if (visualKeys.length === 0) return [];
  return resolveMediaPathsForClaude(visualKeys);
}

/**
 * Resolve message media for Claude: storage keys → absolute paths;
 * legacy CDN URLs → download on the fly.
 */
export async function resolveMediaPathsForClaude(stored: string[]): Promise<string[]> {
  const paths: string[] = [];
  const remote: string[] = [];

  for (const item of stored) {
    if (isRemoteMediaUrl(item)) {
      remote.push(item);
      continue;
    }
    try {
      paths.push(resolveStorageKey(item));
    } catch (err) {
      log.warn({ err, item }, 'Skipping invalid media storage key');
    }
  }

  if (remote.length > 0) {
    const downloaded = await persistRemoteMediaUrls(remote);
    for (const key of downloaded) {
      if (!key) continue;
      try {
        paths.push(resolveStorageKey(key));
      } catch {
        /* skip */
      }
    }
  }

  return paths;
}

/** @deprecated Use persistRemoteMediaUrls — kept for callers expecting absolute paths. */
export async function downloadAllMedia(urls: string[]): Promise<string[]> {
  const keys = (await persistRemoteMediaUrls(urls)).filter((k): k is string => k !== null);
  return keys
    .map((key) => {
      try {
        return resolveStorageKey(key);
      } catch {
        return null;
      }
    })
    .filter((p): p is string => p !== null);
}
