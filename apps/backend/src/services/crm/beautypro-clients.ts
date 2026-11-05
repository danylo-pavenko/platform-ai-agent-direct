/**
 * BeautyPro client lookup/upsert helpers (phone variants, IG note marker).
 * GET /clients filters (docs): phone, email, card_number, name, location, archive.
 * There is NO instagram/username filter — try `name` ≈ handle. We do not write
 * IG onto the client card.
 *
 * Live API 400s unknown names (`Unknown parameter 'X'`). GET `fields` must not
 * include `comment` / `comments` / `id` (id is always returned; live 07.09.2026
 * rejected `comment` in fields). POST/PUT **body** is only
 * firstname/lastname/phone/email — live POST also 400s body `comment`.
 * Visit notes belong on POST /appointments `comments` (plural).
 */

import { normalizeUaPhone } from '../../lib/client-contact-heuristics.js';

/** List fields for phone/email match + ranking when duplicates share a number. */
export const BP_CLIENT_LIST_FIELDS =
  'name,firstname,lastname,phone,email,archive,first_visit,last_visit,bonus,create_date';

export const BP_IG_COMMENT_PREFIX = 'IG:@';

export function normalizeIgUsername(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!cleaned || cleaned.length < 2) return null;
  // Instagram usernames: letters, digits, underscore, period
  if (!/^[a-z0-9._]{2,30}$/i.test(cleaned)) return null;
  return cleaned;
}

export function igCommentMarker(username: string): string {
  const u = normalizeIgUsername(username);
  return u ? `${BP_IG_COMMENT_PREFIX}${u}` : '';
}

export function commentsContainIg(comments: string | null | undefined, username: string): boolean {
  const u = normalizeIgUsername(username);
  if (!u || !comments) return false;
  const hay = comments.toLowerCase();
  return (
    hay.includes(`${BP_IG_COMMENT_PREFIX}${u}`) ||
    hay.includes(`ig: @${u}`) ||
    hay.includes(`instagram: @${u}`) ||
    hay.includes(`@${u}`)
  );
}

/** Digits only — for comparing BeautyPro `phone[]` values to a lookup. */
export function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * BeautyPro UI / docs style: `+380 (93) 710 23 26`.
 * Live salons often store this exact spacing; plain +380… alone can miss.
 */
export function formatUaPhoneBeautyproDisplay(e164: string): string | null {
  const ua = normalizeUaPhone(e164);
  if (!ua) return null;
  const n = ua.slice(4); // 9 national digits
  if (n.length !== 9) return null;
  return `+380 (${n.slice(0, 2)}) ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7, 9)}`;
}

/**
 * Phone query variants for BeautyPro `phone` filter.
 * API examples use formatted numbers; salons store +380 / 380 / 0XX / spaced inconsistently.
 */
export function buildClientPhoneSearchVariants(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const digits = phoneDigits(trimmed);
  const ua = normalizeUaPhone(trimmed);
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    const s = (v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };

  // Prefer canonical UA E.164 first (best match for most BeautyPro DBs).
  if (ua) {
    push(ua);
    push(ua.replace(/^\+/, '')); // 380XXXXXXXXX
    const national0 = `0${ua.slice(4)}`; // 0XXXXXXXXX
    push(national0);
    const display = formatUaPhoneBeautyproDisplay(ua);
    if (display) {
      push(display);
      push(display.replace(/^\+/, '')); // 380 (93) …
      push(national0.replace(/(\d{3})(\d{3})(\d{2})(\d{2})/, '$1 $2 $3 $4')); // 093 710 23 26
    }
    // Last 9 national digits — UI search-by-fragment style when full format misses.
    push(ua.slice(4));
  }

  push(trimmed);
  push(digits);

  // International without + if not already covered
  if (digits.startsWith('380') && digits.length === 12) {
    push(`+${digits}`);
  }

  return out;
}

function rowPhoneList(row: Pick<RawClientLike, 'phone'>): string[] {
  const raw = row.phone;
  if (Array.isArray(raw)) return raw.map((p) => String(p ?? ''));
  if (typeof raw === 'string' && raw.trim()) return [raw];
  return [];
}

/** True when any stored phone equals the lookup (digit-normalized, UA-aware). */
export function clientRowMatchesPhone(
  row: Pick<RawClientLike, 'phone'>,
  lookupPhone: string,
): boolean {
  const want = phoneDigits(normalizeUaPhone(lookupPhone) ?? lookupPhone);
  if (want.length < 9) return false;
  const wantTail = want.length >= 9 ? want.slice(-9) : want;
  for (const p of rowPhoneList(row)) {
    const got = phoneDigits(normalizeUaPhone(p) ?? p);
    if (!got) continue;
    if (got === want) return true;
    if (got.slice(-9) === wantTail) return true;
  }
  return false;
}

function hasCyrillicName(row: Pick<RawClientLike, 'name' | 'firstname' | 'lastname'>): boolean {
  const blob = [row.name, row.firstname, row.lastname].filter(Boolean).join(' ');
  return /[А-ЯІЇЄҐа-яіїєґ]/.test(blob);
}

function hasVisitHistory(row: RawClientLike): boolean {
  const first = typeof row.first_visit === 'string' ? row.first_visit.trim() : '';
  const last = typeof row.last_visit === 'string' ? row.last_visit.trim() : '';
  return Boolean(first || last);
}

/**
 * When BeautyPro returns several cards for one phone (or a fragment search),
 * keep the salon «real» client — history / Cyrillic ПІБ / bonuses — not a
 * one-off Latin duplicate the agent may have created earlier.
 */
export function pickBestBeautyproClient(
  rows: RawClientLike[] | null | undefined,
  lookupPhone: string,
): RawClientLike | null {
  if (!rows?.length) return null;
  const matched = rows.filter(
    (r) => r?.id && (clientRowMatchesPhone(r, lookupPhone) || !lookupPhone.trim()),
  );
  const pool = (matched.length > 0 ? matched : rows.filter((r) => r?.id)).filter(
    (r) => r.archive !== true,
  );
  const candidates = pool.length > 0 ? pool : rows.filter((r) => r?.id);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const scored = candidates.map((row, index) => {
    let score = 0;
    if (clientRowMatchesPhone(row, lookupPhone)) score += 100;
    if (hasVisitHistory(row)) score += 40;
    if (hasCyrillicName(row)) score += 20;
    const bonus = typeof row.bonus === 'number' ? row.bonus : 0;
    score += Math.min(bonus, 50);
    // Prefer older cards (stable salon record) over fresh AI duplicates.
    const created = typeof row.create_date === 'string' ? Date.parse(row.create_date) : NaN;
    if (Number.isFinite(created)) score += Math.max(0, 10 - index);
    return { row, score, created: Number.isFinite(created) ? created : Number.POSITIVE_INFINITY, index };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.created !== b.created) return a.created - b.created;
    return a.index - b.index;
  });
  return scored[0]!.row;
}

export function buildIgNameSearchVariants(username: string): string[] {
  const u = normalizeIgUsername(username);
  if (!u) return [];
  return [u, `@${u}`];
}

/**
 * BeautyPro `name` filter variants: full ПІБ, swapped order, then tokens ≥3 chars
 * (surname alone, given name alone) — longest first to prefer precise hits.
 */
export function buildPersonNameSearchVariants(raw: string | undefined | null): string[] {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[«»""]/g, '');
  if (!cleaned || cleaned.length < 2) return [];

  const out: string[] = [];
  const push = (v: string) => {
    const s = v.trim();
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };

  push(cleaned);
  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    push(`${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`);
    push([...parts].reverse().join(' '));
  }
  const tokens = parts
    .map((p) => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((p) => p.length >= 3);
  tokens.sort((a, b) => b.length - a.length);
  for (const t of tokens) push(t);

  return out;
}

function normalizeNameBlob(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[''`ʼ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Score how well a CRM row matches a person-name query (higher = better). */
export function scoreBeautyproClientNameMatch(
  row: Pick<RawClientLike, 'name' | 'firstname' | 'lastname'>,
  query: string,
): number {
  const q = normalizeNameBlob(query);
  if (!q) return 0;
  const full = normalizeNameBlob(
    formatBeautyproClientFullName(row) ?? [row.firstname, row.lastname, row.name].filter(Boolean).join(' '),
  );
  if (!full) return 0;

  let score = 0;
  if (full === q) score += 100;
  else if (full.includes(q) || q.includes(full)) score += 70;

  const qTokens = q.split(' ').filter((t) => t.length >= 2);
  const fTokens = full.split(' ').filter(Boolean);
  let tokenHits = 0;
  for (const qt of qTokens) {
    if (fTokens.some((ft) => ft === qt || ft.startsWith(qt) || qt.startsWith(ft))) {
      tokenHits += 1;
    }
  }
  if (qTokens.length > 0 && tokenHits === qTokens.length) score += 40;
  else score += tokenHits * 12;

  if (hasCyrillicName(row)) score += 8;
  if (hasVisitHistory(row as RawClientLike)) score += 10;
  return score;
}

export function pickBestBeautyproClientByName(
  rows: RawClientLike[] | null | undefined,
  query: string,
): RawClientLike | null {
  if (!rows?.length || !query.trim()) return null;
  const active = rows.filter((r) => r?.id && r.archive !== true);
  const pool = active.length > 0 ? active : rows.filter((r) => r?.id);
  if (pool.length === 0) return null;

  const scored = pool.map((row, index) => ({
    row,
    score: scoreBeautyproClientNameMatch(row, query),
    index,
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0]!;
  // Require a real name signal — avoid random first-page hits on weak tokens.
  if (best.score < 24) return null;
  return best.row;
}

/** Prefer UA E.164; else first non-empty phone on the CRM card. */
export function primaryPhoneFromBeautyproRow(
  row: Pick<RawClientLike, 'phone'>,
): string | undefined {
  const phones = rowPhoneList(row);
  for (const p of phones) {
    const ua = normalizeUaPhone(p);
    if (ua) return ua;
  }
  const first = phones.map((p) => p.trim()).find(Boolean);
  return first;
}

export type RawClientLike = {
  id: string;
  name?: string;
  firstname?: string;
  lastname?: string;
  phone?: string[] | string | null;
  email?: string[] | string | null;
  comment?: string | null;
  /** Legacy / mistaken key — prefer `comment`. */
  comments?: string | null;
  archive?: boolean | null;
  first_visit?: string | null;
  last_visit?: string | null;
  bonus?: number | null;
  create_date?: string | null;
};

/** Human-readable name from BeautyPro client list row. */
export function formatBeautyproClientFullName(
  row: Pick<RawClientLike, 'name' | 'firstname' | 'lastname'>,
): string | undefined {
  const composed = [row.firstname, row.lastname]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  const fromName = typeof row.name === 'string' ? row.name.trim() : '';
  const n = fromName || composed;
  return n || undefined;
}

export function clientNoteFromBeautyproRow(
  row: Pick<RawClientLike, 'comment' | 'comments'>,
): string | null {
  const v = row.comment ?? row.comments;
  return v?.trim() ? v : null;
}

export type BeautyproClientWriteMode = 'create' | 'update';

/**
 * POST/PUT /clients body. Do not send `comment` / `comments` / `fields` / `id` —
 * live create rejects `comment`; docs create example has no note field.
 * PUT of an existing card sends phone/email only — never firstname/lastname.
 */
export function buildBeautyproClientWriteBody(input: {
  mode: BeautyproClientWriteMode;
  firstname: string;
  lastname: string;
  phone?: string;
  email?: string;
}): Record<string, string | string[]> {
  const firstname = input.firstname.trim() || 'Client';
  const lastname = input.lastname.trim();
  const phone = formatPhoneForBeautyproWrite(input.phone);
  const email = input.email?.trim().toLowerCase() || undefined;
  const body: Record<string, string | string[]> = {};
  // Existing CRM cards keep the salon name. Chat/local name must not PUT over it.
  if (input.mode === 'create') {
    body.firstname = firstname;
    body.lastname = lastname;
  }
  if (phone) body.phone = input.mode === 'update' ? [phone] : phone;
  if (email) body.email = input.mode === 'update' ? [email] : email;
  return body;
}

export function pickClientMatchingIg(
  rows: RawClientLike[] | null | undefined,
  username: string,
): RawClientLike | null {
  const u = normalizeIgUsername(username);
  if (!u || !rows?.length) return null;

  const exactComment = rows.find((r) => commentsContainIg(clientNoteFromBeautyproRow(r), u));
  if (exactComment) return exactComment;

  // Weak fallback: name fields equal handle (some salons paste nick as name)
  const byName = rows.find((r) => {
    const blob = [r.name, r.firstname, r.lastname]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/^@+/, '');
    return blob === u || blob.includes(u);
  });
  return byName ?? null;
}

/** Prefer +380… for writes when the number is a UA mobile. */
export function formatPhoneForBeautyproWrite(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  return normalizeUaPhone(raw) ?? raw.trim();
}
