import type { Prisma } from '../generated/prisma/client.js';

/** Normalized media kind for admin UI and Claude routing. */
export type MediaKind = 'image' | 'video' | 'audio' | 'file' | 'unknown';

export type MediaAttachmentStatus = 'ready' | 'unavailable' | 'unsupported';

export type MediaAttachmentReason = 'download_failed' | 'unsupported' | 'expired';

export type SttStatus = 'ok' | 'failed' | 'skipped' | 'too_long' | 'disabled';

/** Persisted on Message.mediaAttachments (JSONB). */
export interface StoredMediaAttachment {
  kind: MediaKind;
  /** Raw Meta attachment type, e.g. audio, video, share_image, unsupported */
  igType: string;
  status: MediaAttachmentStatus;
  storageKey?: string;
  reason?: MediaAttachmentReason;
  /** STT output (Phase 2+) */
  transcript?: string;
  sttStatus?: SttStatus;
  durationSec?: number;
}

const AUDIO_EXTS = new Set(['.m4a', '.aac', '.mp3', '.ogg', '.wav', '.bin']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Map Meta webhook attachment.type → our kind. */
export function igTypeToMediaKind(igType: string): MediaKind {
  switch (igType) {
    case 'image':
    case 'sticker':
    case 'share_image':
    case 'story_reply_image':
      return 'image';
    case 'video':
    case 'ig_reel':
    case 'reel':
      return 'video';
    case 'audio':
      return 'audio';
    case 'file':
      return 'file';
    case 'story_mention':
      // Ephemeral — we do not treat as durable visual for Claude disk cache.
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Infer kind from a local storage key extension (legacy rows without mediaAttachments). */
export function inferKindFromStorageKey(storageKey: string): MediaKind {
  const dot = storageKey.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  const ext = storageKey.slice(dot).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

export function isVisualMediaKind(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'video';
}

export function isPlayableMediaAttachment(item: StoredMediaAttachment): boolean {
  return item.status === 'ready' && !!item.storageKey;
}

/** Storage keys for Claude vision (images via stream-json; video skipped with a prompt note). */
export function visualStorageKeys(
  attachments: StoredMediaAttachment[] | undefined,
  legacyMediaUrls?: string[],
): string[] {
  if (attachments && attachments.length > 0) {
    return attachments
      .filter(
        (a) =>
          a.status === 'ready' &&
          a.storageKey &&
          isVisualMediaKind(a.kind),
      )
      .map((a) => a.storageKey!);
  }
  return (legacyMediaUrls ?? []).filter((key) =>
    isVisualMediaKind(inferKindFromStorageKey(key)),
  );
}

/** Prisma JSONB write — typed interfaces are not assignable to InputJsonValue directly. */
export function storedMediaAttachmentsForDb(
  attachments: StoredMediaAttachment[],
): Prisma.InputJsonValue | undefined {
  if (attachments.length === 0) return undefined;
  return attachments as unknown as Prisma.InputJsonValue;
}

/** Build attachment views from legacy mediaUrls only (pre-migration messages). */
export function legacyAttachmentsFromMediaUrls(urls: string[]): StoredMediaAttachment[] {
  return urls.map((storageKey) => ({
    kind: inferKindFromStorageKey(storageKey),
    igType: inferKindFromStorageKey(storageKey),
    status: 'ready' as const,
    storageKey,
  }));
}
