/**
 * Distinguishes a person's name (said in chat) from an Instagram profile
 * title / bio headline ("Йога для вагітних і після пологів").
 */

const NAME_TOKEN_RE = /^[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’\-]*$/u;

const SLOGAN_MARKERS =
  /\b(для|після|про|студі[яюї]|салон|йога|yoga|фітнес|fitness|тренер|клінік|майстер-клас|онлайн|online|spa|nail|beauty|барбер|barber|стоматолог|масаж|полог|вагітн|real estate|official|brand)\b/iu;

const IG_TITLE_SEPARATORS = /[|·•—–]|🙂|✨|💕|🌿|🧘/;

const NAME_STOP =
  /^(манікюр|педикюр|брови|вії|стрижка|фарбування|комплекс|дизайн|френч|укріплення|завтра|сьогодні|понеділок|вівторок|середа|четвер|п['’]?ятниця|субота|неділя|йога|тренер|студія|салон|онлайн|доброго|привіт|вітаю|здрастуй|hello|hi)$/iu;

function normalizeNameKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA');
}

function tokensOf(value: string): string[] {
  return value.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
}

/** Instagram headline / business title — not a person. */
export function isIgProfileTitleNotPersonName(value: string | null | undefined): boolean {
  const t = (value ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return false;
  if (t.length > 48) return true;
  if (IG_TITLE_SEPARATORS.test(t)) return true;
  if (SLOGAN_MARKERS.test(t)) return true;
  const tokens = tokensOf(t);
  if (tokens.length > 4) return true;
  if (tokens.some((w) => NAME_STOP.test(w))) return true;
  return false;
}

/** 1–4 name tokens, no slogan / service words. Allows «Діана» or «Тимофіїв Анжела». */
export function isPlausiblePersonName(value: string | null | undefined): boolean {
  const t = (value ?? '').trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > 48) return false;
  if (isIgProfileTitleNotPersonName(t)) return false;
  const tokens = tokensOf(t);
  if (tokens.length < 1 || tokens.length > 4) return false;
  if (tokens.some((w) => !NAME_TOKEN_RE.test(w) || NAME_STOP.test(w))) return false;
  return true;
}

const CYRILLIC_RE = /[А-ЯІЇЄҐа-яіїєґ]/u;

/**
 * Name said in chat (or typed in admin) — not a copy of the IG profile title.
 * `displayName === igFullName` is IG-seeded, so a later chat intro can replace it.
 */
export function effectiveChatDisplayName(
  displayName: string | null | undefined,
  igFullName?: string | null,
): string | undefined {
  const name = (displayName ?? '').trim().replace(/\s+/g, ' ');
  if (!name || !isPlausiblePersonName(name)) return undefined;
  const ig = (igFullName ?? '').trim().replace(/\s+/g, ' ');
  if (ig && normalizeNameKey(name) === normalizeNameKey(ig)) return undefined;
  return name;
}

/**
 * Instagram Graph `name` when it looks like a person (Олена Коваль, Діана).
 * Skips slogans and one-word Latin brands (Moxito).
 */
export function igProfilePersonName(value: string | null | undefined): string | undefined {
  const t = (value ?? '').trim().replace(/\s+/g, ' ');
  if (!isPlausiblePersonName(t)) return undefined;
  const tokens = tokensOf(t);
  if (tokens.length === 1 && !CYRILLIC_RE.test(tokens[0]!)) return undefined;
  return t;
}

/** Chat name, else a person-like IG profile name. Never a headline. */
export function effectiveClientPersonName(
  displayName: string | null | undefined,
  igFullName?: string | null,
): string | undefined {
  return (
    effectiveChatDisplayName(displayName, igFullName) ?? igProfilePersonName(igFullName)
  );
}

/** CRM / booking: person name, then @handle — never a headline. */
export function crmPersonFullName(client: {
  displayName?: string | null;
  igFullName?: string | null;
  igUsername?: string | null;
}): string | null {
  const person = effectiveClientPersonName(client.displayName, client.igFullName);
  if (person) return person;
  if (client.igUsername?.trim()) return `@${client.igUsername.trim().replace(/^@/, '')}`;
  return null;
}
