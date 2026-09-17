/**
 * B.3 session window: after this many days of silence, inbound should start
 * a new conversation (greeting + analytics) instead of replaying the old thread.
 *
 * `handoff` is included: idle TTL returns the bot to the *same* UUID after ~60m,
 * which is correct for a lunch break, but not for a month-old payment dispute.
 * `paused` stays human-owned and is not auto-closed.
 */

export const MS_PER_DAY = 86_400_000;

export function sessionGapDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export function isSessionGapPastFreshness(
  from: Date,
  to: Date,
  sessionFreshnessDays: number,
): boolean {
  if (sessionFreshnessDays <= 0) return false;
  return to.getTime() - from.getTime() > sessionFreshnessDays * MS_PER_DAY;
}

export function isConversationStaleForNewSession(params: {
  state: string;
  lastMessageAt: Date | null | undefined;
  sessionFreshnessDays: number;
  nowMs?: number;
}): boolean {
  const { state, lastMessageAt, sessionFreshnessDays, nowMs = Date.now() } = params;
  if (sessionFreshnessDays <= 0) return false;
  if (state !== 'bot' && state !== 'handoff') return false;
  if (!lastMessageAt) return false;
  return nowMs - lastMessageAt.getTime() > sessionFreshnessDays * MS_PER_DAY;
}
