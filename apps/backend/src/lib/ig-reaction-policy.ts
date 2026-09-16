/**
 * Instagram message_reactions: persist for admin, do not let likes
 * spawn Claude replies (hearts on every bot bubble become spam).
 */

const LIKE_REACTION_NAMES = new Set(['like', 'love']);

const LIKE_EMOJI_RE =
  /^(?:❤️|❤|💕|💗|💖|♥️|🖤|💙|💚|💛|🧡|💜|🤍|🤎|👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/u;

const SYNTHETIC_REACTION_TEXT_RE = /^реакція\s+/iu;

export function isSyntheticReactionText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && SYNTHETIC_REACTION_TEXT_RE.test(t);
}

export function isLikeOrHeartReaction(reaction?: string, emoji?: string): boolean {
  const name = (reaction ?? '').trim().toLowerCase();
  if (LIKE_REACTION_NAMES.has(name)) return true;
  const mark = (emoji ?? '').trim();
  return mark.length > 0 && LIKE_EMOJI_RE.test(mark);
}

/**
 * Reaction-only webhook: never start a Claude / IG reply turn.
 * Unusual reactions (wow/sad/angry) are stored the same way — a tap is not a question.
 */
export function shouldScheduleBotTurnForReaction(): boolean {
  return false;
}

export function shouldCancelFollowUpOnReaction(reaction?: string, emoji?: string): boolean {
  return !isLikeOrHeartReaction(reaction, emoji) && shouldScheduleBotTurnForReaction();
}
