import type { StoredMediaAttachment } from './media-attachments.js';
import type { SharedPostData } from '../routes/webhooks.js';
import {
  type IgInboundContext,
  type IgInboundKind,
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

/** Prefer story/inline over a lone reaction when several mids coalesce. */
const IG_CONTEXT_PRIORITY: Record<IgInboundKind, number> = {
  story_reply: 4,
  story_mention: 3,
  inline_reply: 2,
  reaction: 1,
};

/** Only bot-owned IG threads should show typing during coalesce wait. */
export function shouldBootstrapIgTyping(state: string): boolean {
  return state === 'bot';
}

/**
 * Re-arm coalesce after a flush only when inbound arrived during the turn
 * *and* those mids are still unclaimed. Absorbed bubbles set dirty but leave
 * nothing to drain — re-arming would bootstrap typing with no owner to stop it.
 */
export function shouldRearmCoalesceAfterFlush(opts: {
  dirty: boolean;
  pendingCount: number;
}): boolean {
  return opts.dirty && opts.pendingCount > 0;
}

/** Typing bootstrap is only valid while this burst is still waiting to flush. */
export function shouldStartCoalesceTypingBootstrap(opts: {
  burstStartedAt: number | null;
  flushing: boolean;
}): boolean {
  return opts.burstStartedAt != null && !opts.flushing;
}

/**
 * A late bootstrap (slow DB / Meta) finished after the burst already flushed
 * and drain is not running — stop typing so keepalive cannot leak.
 */
export function shouldStopLateCoalesceTypingBootstrap(opts: {
  burstStartedAt: number | null;
  flushing: boolean;
}): boolean {
  return opts.burstStartedAt == null && !opts.flushing;
}

/**
 * After a flush, stop coalesce typing only when we are not waiting on another
 * burst. A new inbound can arm timers while we await pending rows.
 */
export function shouldStopCoalesceTypingAfterFlush(opts: {
  rearm: boolean;
  burstStartedAt: number | null;
}): boolean {
  return !opts.rearm && opts.burstStartedAt == null;
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

/**
 * Floor for unclaimed inbound that still need a Claude turn.
 *
 * Prefer the last *claimed* inbound over the last bot outbound. Messages that
 * arrive while Claude is running are timestamped *before* the bot reply, so a
 * last-outbound floor would orphan them (time + name + phone as separate
 * Instagram bubbles).
 *
 * When nothing has been claimed yet (legacy rows / first drain), fall back to
 * last real outbound so we do not replay the whole thread.
 */
export function resolvePendingInboundFloor(args: {
  lastClaimedInboundAt?: Date | null;
  lastRealOutboundAt?: Date | null;
  onlyAfter?: Date;
}): Date | undefined {
  const candidates: Date[] = [];
  if (args.lastClaimedInboundAt) {
    candidates.push(args.lastClaimedInboundAt);
  } else if (args.lastRealOutboundAt) {
    candidates.push(args.lastRealOutboundAt);
  }
  if (args.onlyAfter) {
    candidates.push(args.onlyAfter);
  }
  if (candidates.length === 0) return undefined;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

const COMPLETE_ACK_RE =
  /^(так|ні|неа|ок|окей|добре|гаразд|дякую|супер|ага|угу|yes|no|ok|okay|thanks|thank you)[.!?…]*$/iu;

const TIME_ONLY_RE = /^(?:о\s+|на\s+)?\d{1,2}[:.]\d{2}$/u;
const DATE_ONLY_RE = /^\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?$/u;
const PHONE_ONLY_RE = /^[\d\s+\-()]{9,16}$/u;
const PERSON_NAME_RE =
  /^[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’\-]+(?:\s+[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’\-]+){1,2}$/u;

/**
 * True when this Instagram bubble is likely one piece of a multi-bubble
 * answer (time, name, phone) rather than a complete sentence.
 * Used to stretch coalesce silence so "10:00" + "Прізвище Ім'я" + phone
 * become one Claude turn.
 */
export function looksLikePartialUtterance(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (COMPLETE_ACK_RE.test(t)) return false;
  if (/[?!]$/.test(t)) return false;
  if (TIME_ONLY_RE.test(t) || DATE_ONLY_RE.test(t) || PHONE_ONLY_RE.test(t)) return true;
  if (PERSON_NAME_RE.test(t) && t.length <= 60) return true;
  // Short fragment without sentence end — typical IG split typing.
  if (t.length <= 24 && !/[.!?…]$/.test(t) && !/\n/.test(t)) return true;
  return false;
}

export function resolveCoalesceWindowMs(
  partialBurst: boolean,
  complete: { silenceMs: number; maxWaitMs: number },
  partial: { silenceMs: number; maxWaitMs: number },
): { silenceMs: number; maxWaitMs: number } {
  if (!partialBurst) return complete;
  return {
    silenceMs: Math.max(complete.silenceMs, partial.silenceMs),
    maxWaitMs: Math.max(complete.maxWaitMs, partial.maxWaitMs),
  };
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

function pickIgContext(messages: PendingInboundMessage[]): IgInboundContext | undefined {
  let best: IgInboundContext | undefined;
  let bestScore = -1;
  for (const m of messages) {
    const ctx = parseIgInboundContext(m.igContext);
    if (!ctx) continue;
    const score = IG_CONTEXT_PRIORITY[ctx.kind] ?? 0;
    // Later message wins ties so a follow-up story reply beats an earlier one.
    if (score >= bestScore) {
      best = ctx;
      bestScore = score;
    }
  }
  return best;
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
    const numbered = texts.map((t, i) => `${i + 1}) ${t}`).join('\n');
    text =
      'Клієнт надіслав кілька повідомлень підряд — це ОДНА відповідь ' +
      `(читай суцільно, не як окремі репліки):\n${numbered}`;
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

  return {
    text,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
    sharedPost,
    igContext: pickIgContext(messages),
    igMessageIds,
    messageIds,
  };
}
