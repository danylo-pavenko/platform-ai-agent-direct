import type { StoredMediaAttachment } from './media-attachments.js';
import type { SharedPostData } from '../routes/webhooks.js';
import {
  type IgInboundContext,
  parseIgInboundContext,
} from './ig-inbound-context.js';

export interface PendingInboundMessage {
  id: string;
  text: string | null;
  mediaUrls: unknown;
  mediaAttachments: unknown;
  sharedPost: unknown;
  igContext: unknown;
  igMessageId: string | null;
  createdAt: Date;
}

export interface JoinedInboundBatch {
  text: string;
  mediaUrls?: string[];
  mediaAttachments?: StoredMediaAttachment[];
  sharedPost?: SharedPostData;
  igContext?: IgInboundContext;
  igMessageIds: string[];
  messageIds: string[];
}

/**
 * Delay until the next coalesce flush.
 * Fires on silence after the last mid, capped by max-wait from burst start.
 */
export function computeCoalesceDelayMs(
  nowMs: number,
  burstStartedAtMs: number,
  silenceMs: number,
  maxWaitMs: number,
): number {
  const silenceTarget = nowMs + Math.max(0, silenceMs);
  const maxTarget = burstStartedAtMs + Math.max(0, maxWaitMs);
  const fireAt = Math.min(silenceTarget, maxTarget);
  return Math.max(0, fireAt - nowMs);
}

function parseMediaUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function parseMediaAttachments(value: unknown): StoredMediaAttachment[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value as StoredMediaAttachment[];
}

function parseSharedPost(value: unknown): SharedPostData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as SharedPostData;
}

/** Join one or more pending inbound rows into a single Claude user turn. */
export function joinInboundBatch(messages: PendingInboundMessage[]): JoinedInboundBatch {
  const messageIds = messages.map((m) => m.id);
  const igMessageIds = messages
    .map((m) => m.igMessageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const texts = messages
    .map((m) => (m.text ?? '').trim())
    .filter((t) => t.length > 0);

  let text: string;
  if (texts.length <= 1) {
    text = texts[0] ?? '';
  } else {
    text = `Клієнт надіслав кілька повідомлень підряд:\n\n${texts.join('\n\n')}`;
  }

  const mediaUrls = messages.flatMap((m) => parseMediaUrls(m.mediaUrls));
  const mediaAttachments = messages.flatMap((m) => parseMediaAttachments(m.mediaAttachments));

  let sharedPost: SharedPostData | undefined;
  for (const m of messages) {
    const sp = parseSharedPost(m.sharedPost);
    if (sp) {
      sharedPost = sp;
      break;
    }
  }

  let igContext: IgInboundContext | undefined;
  for (const m of messages) {
    const ctx = parseIgInboundContext(m.igContext);
    if (ctx) {
      igContext = ctx;
      break;
    }
  }

  return {
    text,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
    sharedPost,
    igContext,
    igMessageIds,
    messageIds,
  };
}
