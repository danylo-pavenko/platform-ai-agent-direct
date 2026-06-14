import { resolveMessageMediaSrc } from './mediaUrl';

export type MediaKind = 'image' | 'video' | 'audio' | 'file' | 'unknown';
export type MediaAttachmentStatus = 'ready' | 'unavailable' | 'unsupported';

export interface StoredMediaAttachment {
  kind: MediaKind;
  igType: string;
  status: MediaAttachmentStatus;
  storageKey?: string;
  reason?: 'download_failed' | 'unsupported' | 'expired';
  transcript?: string;
  sttStatus?: 'ok' | 'failed' | 'skipped' | 'too_long' | 'disabled';
  durationSec?: number;
}

export interface MessageMediaViewItem {
  kind: MediaKind;
  status: MediaAttachmentStatus;
  storageKey?: string;
  transcript?: string;
  sttStatus?: StoredMediaAttachment['sttStatus'];
  /** Human label when playback/download is not available */
  unavailableLabel?: string;
  playable: boolean;
  src?: string;
  downloadHref?: string;
}

const AUDIO_EXTS = /\.(m4a|aac|mp3|ogg|wav|bin)(\?|$)/i;
const VIDEO_EXTS = /\.(mp4|mov|webm)(\?|$)/i;
const IMAGE_EXTS = /\.(jpe?g|png|gif|webp)(\?|$)/i;

function inferKindFromKey(key: string): MediaKind {
  if (IMAGE_EXTS.test(key)) return 'image';
  if (VIDEO_EXTS.test(key)) return 'video';
  if (AUDIO_EXTS.test(key)) return 'audio';
  return 'file';
}

function unavailableLabelFor(kind: MediaKind, status: MediaAttachmentStatus): string {
  if (status === 'unsupported') {
    return 'Медіа від Instagram — формат поки не підтримується';
  }
  switch (kind) {
    case 'audio':
      return 'Голосове повідомлення — прослухати поки недоступно';
    case 'video':
      return 'Відео — перегляд поки недоступний';
    case 'file':
      return 'Файл — завантаження поки недоступне';
    case 'image':
      return 'Зображення — перегляд поки недоступний';
    default:
      return 'Медіа-повідомлення — перегляд поки недоступний';
  }
}

function toViewItem(
  kind: MediaKind,
  status: MediaAttachmentStatus,
  storageKey?: string,
  extra?: Pick<StoredMediaAttachment, 'transcript' | 'sttStatus'>,
): MessageMediaViewItem {
  const playable = status === 'ready' && !!storageKey;
  const src = playable && storageKey ? resolveMessageMediaSrc(storageKey) : undefined;
  return {
    kind,
    status,
    storageKey,
    transcript: extra?.transcript,
    sttStatus: extra?.sttStatus,
    playable,
    src,
    downloadHref: playable && kind === 'file' ? src : undefined,
    unavailableLabel: playable ? undefined : unavailableLabelFor(kind, status),
  };
}

/** Normalize message media for admin chat rendering (supports legacy rows). */
export function getMessageMediaItems(msg: {
  mediaAttachments?: StoredMediaAttachment[] | null;
  mediaUrls?: string[] | null;
}): MessageMediaViewItem[] {
  const structured = msg.mediaAttachments ?? [];
  if (structured.length > 0) {
    return structured.map((a) =>
      toViewItem(a.kind, a.status, a.storageKey, {
        transcript: a.transcript,
        sttStatus: a.sttStatus,
      }),
    );
  }

  const legacy = msg.mediaUrls ?? [];
  return legacy.map((key) => {
    const kind = inferKindFromKey(key);
    return toViewItem(kind, 'ready', key);
  });
}

export function messageHasVisibleContent(msg: {
  text?: string | null;
  mediaAttachments?: StoredMediaAttachment[] | null;
  mediaUrls?: string[] | null;
  sharedPost?: { postUrl?: string } | null;
}): boolean {
  if (msg.text?.trim()) return true;
  if (msg.sharedPost?.postUrl) return true;
  return getMessageMediaItems(msg).length > 0;
}

export function mediaKindIcon(kind: MediaKind): string {
  return (
    {
      audio: 'mdi-microphone',
      video: 'mdi-video',
      image: 'mdi-image',
      file: 'mdi-paperclip',
      unknown: 'mdi-help-circle-outline',
    } as Record<MediaKind, string>
  )[kind];
}
