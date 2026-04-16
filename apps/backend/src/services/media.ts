import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { config } from '../config.js';

const log = pino({ name: 'media' });

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
};

/**
 * Download a single media file from URL to local storage.
 * Instagram CDN URLs expire within minutes, so this should be called promptly.
 *
 * @returns Local file path on success, null on failure.
 */
export async function downloadMedia(
  url: string,
  _originalFilename?: string,
): Promise<string | null> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      log.warn({ status: response.status, url }, 'Media download failed: non-OK status');
      return null;
    }

    if (!response.body) {
      log.warn({ url }, 'Media download failed: empty response body');
      return null;
    }

    // Determine extension from Content-Type
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    const ext = CONTENT_TYPE_TO_EXT[contentType] ?? '.bin';

    // Build destination path: {UPLOADS_DIR}/{YYYY}/{MM}/{uuid}.{ext}
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const filename = `${randomUUID()}${ext}`;

    const uploadsDir = resolve(config.UPLOADS_DIR);
    const dir = join(uploadsDir, yyyy, mm);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, filename);

    // Stream response body to file
    const readable = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const writable = createWriteStream(filePath);
    await pipeline(readable, writable);

    // Log file size
    const fileStat = await stat(filePath);
    log.info(
      {
        filePath,
        size: fileStat.size,
        contentType,
        ext,
      },
      `Media downloaded: ${fileStat.size} bytes`,
    );

    return filePath;
  } catch (err) {
    log.error({ err, url }, 'Media download failed');
    return null;
  }
}

/**
 * Download multiple media URLs in parallel.
 *
 * @returns Array of successfully downloaded local file paths (failed downloads are skipped).
 */
export async function downloadAllMedia(urls: string[]): Promise<string[]> {
  try {
    const results = await Promise.all(urls.map((url) => downloadMedia(url)));
    return results.filter((path): path is string => path !== null);
  } catch (err) {
    log.error({ err }, 'downloadAllMedia failed');
    return [];
  }
}
