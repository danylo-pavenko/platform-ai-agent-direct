/** Chat name vs Instagram profile headline for admin labels. */

function looksLikeIgHeadline(name: string): boolean {
  const t = name.trim();
  if (t.length > 48) return true;
  if (/[|·•]/.test(t)) return true;
  return /\b(для|після|йога|тренер|студі|салон|полог|вагітн)\b/i.test(t);
}

function looksLikeIgPersonName(name: string): boolean {
  if (!name || looksLikeIgHeadline(name)) return false;
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 4) return false;
  const only = tokens[0]!;
  if (tokens.length === 1 && /^[A-Za-z'’-]+$/.test(only)) return false;
  return true;
}

/** Person name for the profile field: chat, else a person-like IG name. */
export function adminChatCollectedName(c: {
  displayName?: string | null;
  igFullName?: string | null;
} | null | undefined): string | null {
  if (!c) return null;
  const display = c.displayName?.trim() || '';
  if (display && !looksLikeIgHeadline(display)) return display;
  const ig = c.igFullName?.trim() || '';
  if (ig && looksLikeIgPersonName(ig)) return ig;
  return null;
}

export function adminClientPrimaryName(c: {
  displayName?: string | null;
  igFullName?: string | null;
  igUsername?: string | null;
  igUserId?: string | null;
} | null | undefined): string {
  const person = adminChatCollectedName(c);
  if (person) return person;
  const handle = c?.igUsername?.trim().replace(/^@/, '');
  if (handle) return `@${handle}`;
  return 'Клієнт';
}

export function adminIgProfileTitle(c: {
  igFullName?: string | null;
} | null | undefined): string | null {
  const ig = c?.igFullName?.trim() || '';
  if (!ig || !looksLikeIgHeadline(ig)) return null;
  return ig;
}
