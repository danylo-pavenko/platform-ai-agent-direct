/**
 * Remarketing / silence follow-up eligibility (pure).
 *
 * Instagram: Meta human-agent messaging window is ~24h from the last *client*
 * inbound. Delay settings longer than that can never send via IG API — skip
 * without calling Claude.
 */

/** Hard ceiling for Telegram (and generic) silence age. */
export const FOLLOW_UP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Meta IG/Messenger messaging window (~24h from last client inbound).
 * Outside this, Graph returns 400 / subcode 2534022.
 */
export const IG_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type FollowUpSkipReason =
  | 'no_bot_outbound'
  | 'client_replied'
  | 'manager_replied'
  | 'too_soon'
  | 'too_old'
  | 'already_sent'
  | 'outside_messaging_window'
  | 'delay_exceeds_window'
  | 'disabled';

export interface MessageForFollowUpEval {
  direction: string;
  sender: string;
  createdAt: Date;
}

export interface FollowUpEvalResult {
  needed: boolean;
  reason: FollowUpSkipReason | 'ok';
  lastBotAt: Date | null;
  /**
   * True when this conversation should be marked consumed (followUpSentAt set)
   * without calling Claude or sending — permanent skip until next inbound.
   */
  consumeWithoutSend: boolean;
}

export interface FollowUpEvalOptions {
  delayMs: number;
  maxAgeMs: number;
  followUpAlreadySent: boolean;
  channel?: 'ig' | 'tg';
  /** Last client inbound; required for IG messaging-window gate. */
  lastClientInboundAt?: Date | null;
}

function lastClientInboundAtFromMessages(
  messages: MessageForFollowUpEval[],
): Date | null {
  let latest: Date | null = null;
  for (const m of messages) {
    if (m.direction === 'in' && m.sender === 'client') {
      if (!latest || m.createdAt.getTime() > latest.getTime()) {
        latest = m.createdAt;
      }
    }
  }
  return latest;
}

/**
 * Pure helper — bot spoke last, client silent for >= delayMs and <= maxAgeMs.
 * For Instagram, also requires last client inbound within the Meta messaging window.
 */
export function evaluateFollowUpNeed(
  messages: MessageForFollowUpEval[],
  nowMs: number,
  opts: FollowUpEvalOptions,
): FollowUpEvalResult {
  if (opts.followUpAlreadySent) {
    return {
      needed: false,
      reason: 'already_sent',
      lastBotAt: null,
      consumeWithoutSend: false,
    };
  }

  if (messages.length === 0) {
    return {
      needed: false,
      reason: 'no_bot_outbound',
      lastBotAt: null,
      consumeWithoutSend: false,
    };
  }

  const sorted = [...messages].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const last = sorted[sorted.length - 1]!;

  if (last.direction === 'in' && last.sender === 'client') {
    return {
      needed: false,
      reason: 'client_replied',
      lastBotAt: null,
      consumeWithoutSend: false,
    };
  }

  if (last.direction === 'out' && last.sender === 'manager') {
    return {
      needed: false,
      reason: 'manager_replied',
      lastBotAt: null,
      consumeWithoutSend: false,
    };
  }

  if (!(last.direction === 'out' && last.sender === 'bot')) {
    return {
      needed: false,
      reason: 'no_bot_outbound',
      lastBotAt: null,
      consumeWithoutSend: false,
    };
  }

  const lastBotAt = last.createdAt;
  const ageMs = nowMs - lastBotAt.getTime();
  const channel = opts.channel ?? 'ig';

  // IG: delay longer than Meta window can never deliver — burn the slot, no Claude.
  if (channel === 'ig' && opts.delayMs > IG_MESSAGING_WINDOW_MS) {
    return {
      needed: false,
      reason: 'delay_exceeds_window',
      lastBotAt,
      consumeWithoutSend: true,
    };
  }

  if (ageMs < opts.delayMs) {
    return {
      needed: false,
      reason: 'too_soon',
      lastBotAt,
      consumeWithoutSend: false,
    };
  }

  const effectiveMaxAge =
    channel === 'ig'
      ? Math.min(opts.maxAgeMs, IG_MESSAGING_WINDOW_MS)
      : opts.maxAgeMs;

  if (ageMs > effectiveMaxAge) {
    return {
      needed: false,
      reason: 'too_old',
      lastBotAt,
      // Past IG window (or 7d TG): stop scanning forever until next inbound.
      consumeWithoutSend: channel === 'ig' || ageMs > opts.maxAgeMs,
    };
  }

  if (channel === 'ig') {
    const inboundAt =
      opts.lastClientInboundAt ?? lastClientInboundAtFromMessages(messages);
    if (!inboundAt) {
      return {
        needed: false,
        reason: 'outside_messaging_window',
        lastBotAt,
        consumeWithoutSend: true,
      };
    }
    const inboundAgeMs = nowMs - inboundAt.getTime();
    if (inboundAgeMs > IG_MESSAGING_WINDOW_MS || inboundAgeMs < 0) {
      return {
        needed: false,
        reason: 'outside_messaging_window',
        lastBotAt,
        consumeWithoutSend: true,
      };
    }
  }

  return {
    needed: true,
    reason: 'ok',
    lastBotAt,
    consumeWithoutSend: false,
  };
}

/** Detect Meta "outside allowed messaging window" Graph errors. */
export function isIgOutsideMessagingWindowError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message}\n${err.stack ?? ''}`
      : String(err);
  return (
    /2534022/.test(text) ||
    /outside.*(allowed|messaging).*window/i.test(text) ||
    /message.*window.*expired/i.test(text)
  );
}
