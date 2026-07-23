/** Hard ceiling: never nudge conversations quieter than 7 days. */
export const FOLLOW_UP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type FollowUpSkipReason =
  | 'no_bot_outbound'
  | 'client_replied'
  | 'manager_replied'
  | 'too_soon'
  | 'too_old'
  | 'already_sent'
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
}

/**
 * Pure helper — bot spoke last, client silent for >= delayMs and <= maxAgeMs.
 */
export function evaluateFollowUpNeed(
  messages: MessageForFollowUpEval[],
  nowMs: number,
  opts: { delayMs: number; maxAgeMs: number; followUpAlreadySent: boolean },
): FollowUpEvalResult {
  if (opts.followUpAlreadySent) {
    return { needed: false, reason: 'already_sent', lastBotAt: null };
  }

  if (messages.length === 0) {
    return { needed: false, reason: 'no_bot_outbound', lastBotAt: null };
  }

  const sorted = [...messages].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const last = sorted[sorted.length - 1];

  if (last.direction === 'in' && last.sender === 'client') {
    return { needed: false, reason: 'client_replied', lastBotAt: null };
  }

  if (last.direction === 'out' && last.sender === 'manager') {
    return { needed: false, reason: 'manager_replied', lastBotAt: null };
  }

  if (!(last.direction === 'out' && last.sender === 'bot')) {
    return { needed: false, reason: 'no_bot_outbound', lastBotAt: null };
  }

  const lastBotAt = last.createdAt;
  const ageMs = nowMs - lastBotAt.getTime();

  if (ageMs < opts.delayMs) {
    return { needed: false, reason: 'too_soon', lastBotAt };
  }
  if (ageMs > opts.maxAgeMs) {
    return { needed: false, reason: 'too_old', lastBotAt };
  }

  return { needed: true, reason: 'ok', lastBotAt };
}
