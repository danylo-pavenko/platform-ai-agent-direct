/** Chat name vs Instagram profile headline for admin labels. */

function looksLikeIgHeadline(name: string): boolean {
  const t = name.trim();
  if (t.length > 48) return true;
  if (/[|·•]/.test(t)) return true;
  return /\b(для|після|йога|тренер|студі|салон|полог|вагітн)\b/i.test(t);
}

const SERVICE_OR_FILLER =
  /^(так|ні|нет|да|ок|окей|yes|no|добре|давайте|фарба|фарбою|хна|хною|гель|лак|покриття|корекція|брови|вії|манікюр|педикюр|комплекс)$/iu;

function looksLikeServiceAnswerNotName(name: string): boolean {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  if (tokens.some((w) => SERVICE_OR_FILLER.test(w))) return true;
  if (tokens.length >= 2 && /^(так|ні|нет|да|ок|yes|no)$/i.test(tokens[0]!)) return true;
  return false;
}

function looksLikeIgPersonName(name: string): boolean {
  if (!name || looksLikeIgHeadline(name) || looksLikeServiceAnswerNotName(name)) return false;
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
  if (display && !looksLikeIgHeadline(display) && !looksLikeServiceAnswerNotName(display)) {
    return display;
  }
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
  return c?.igUserId?.trim() || 'Клієнт';
}

/** IG profile title when it differs from the chat person name (caption only). */
export function adminIgProfileTitle(c: {
  displayName?: string | null;
  igFullName?: string | null;
} | null | undefined): string | null {
  if (!c) return null;
  const ig = c.igFullName?.trim() || '';
  if (!ig) return null;
  const person = adminChatCollectedName(c);
  if (person && person.toLocaleLowerCase('uk-UA') === ig.toLocaleLowerCase('uk-UA')) return null;
  if (looksLikeIgPersonName(ig) && !person) return null;
  return ig;
}
