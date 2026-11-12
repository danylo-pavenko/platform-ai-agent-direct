/**
 * Library card assets: persist uploads, public signed URLs for Meta sendImage.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { apiPublicBaseUrl } from '../lib/api-public-url.js';
import type { LibraryAttachment } from '../lib/library-attachments.js';
import { getUploadsRoot, mimeForStorageKey, toStorageKey } from './media.js';

const SIGN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days — Meta may cache is_reusable

function signSecret(): string {
  return config.JWT_SECRET;
}

export function signLibraryAssetToken(
  articleId: string,
  attachmentId: string,
  expSec: number = Math.floor(Date.now() / 1000) + SIGN_TTL_SEC,
): string {
  const payload = `${articleId}.${attachmentId}.${expSec}`;
  const sig = createHmac('sha256', signSecret()).update(payload).digest('hex');
  return `${expSec}.${sig}`;
}

export function verifyLibraryAssetToken(
  articleId: string,
  attachmentId: string,
  token: string,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expRaw, sig] = parts;
  const expSec = Number(expRaw);
  if (!Number.isFinite(expSec) || expSec * 1000 < Date.now()) return false;
  const expected = createHmac('sha256', signSecret())
    .update(`${articleId}.${attachmentId}.${expSec}`)
    .digest('hex');
  try {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** HTTPS URL Meta Graph can fetch for sendImage. */
export function buildPublicLibraryAssetUrl(
  articleId: string,
  attachmentId: string,
): string {
  const token = signLibraryAssetToken(articleId, attachmentId);
  return `${apiPublicBaseUrl()}/public/library-assets/${articleId}/${attachmentId}?t=${encodeURIComponent(token)}`;
}

/** Prefer external https url; else signed public route for uploaded storageKey. */
export function resolveAttachmentDeliveryUrl(
  articleId: string,
  attachment: LibraryAttachment,
): string | null {
  if (attachment.url && /^https:\/\//i.test(attachment.url)) {
    return attachment.url;
  }
  if (attachment.storageKey) {
    return buildPublicLibraryAssetUrl(articleId, attachment.id);
  }
  return null;
}

export async function persistLibraryUpload(opts: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<{ storageKey: string; mime: string; bytes: number }> {
  const bytes = opts.buffer.byteLength;
  if (bytes <= 0 || bytes > 12 * 1024 * 1024) {
    throw new Error('File size must be 1 byte … 12 MB');
  }

  const mime =
    (opts.contentType?.split(';')[0]?.trim() || guessMime(opts.filename) || 'application/octet-stream');
  const ext = extForMime(mime, opts.filename);
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dir = join(getUploadsRoot(), 'library', yyyy, mm);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, `${randomUUID()}${ext}`);
  await pipeline(Readable.from(opts.buffer), createWriteStream(abs));
  return {
    storageKey: toStorageKey(abs),
    mime,
    bytes,
  };
}

function guessMime(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return undefined;
}

function extForMime(mime: string, filename: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
  };
  if (map[mime]) return map[mime];
  const dot = filename.lastIndexOf('.');
  if (dot > 0) return filename.slice(dot).toLowerCase().slice(0, 8);
  return mimeForStorageKey(filename).startsWith('image/') ? '.jpg' : '.bin';
}
