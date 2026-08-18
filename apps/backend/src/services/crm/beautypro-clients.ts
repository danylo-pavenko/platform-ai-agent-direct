/**
 * BeautyPro client lookup/upsert helpers (phone variants, IG note marker).
 * GET /clients filters (docs): phone, email, card_number, name, location, archive.
 * There is NO instagram/username filter — match `IG:@handle` in GET `comment` if
 * the salon typed it, else `name` search. We do not write that note ourselves.
 *
 * Live API 400s unknown names (`Unknown parameter 'X'`). GET `fields` list has
 * `comment` (singular), not `comments`, and no `id` (id is always returned).
 * POST/PUT **body** is not the GET fields list: official create example is only
 * firstname/lastname/phone/email. Live POST /clients 400s body `comment`.
 * Visit notes belong on POST /appointments `comments` (plural).
 */

import { normalizeUaPhone } from '../../lib/client-contact-heuristics.js';

export const BP_CLIENT_LIST_FIELDS =
  'name,firstname,lastname,phone,email,comment,archive';

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

/**
 * Phone query variants for BeautyPro `phone` filter.
 * API examples use formatted numbers; salons store +380 / 380 / 0XX inconsistently.
 */
export function buildClientPhoneSearchVariants(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const digits = trimmed.replace(/\D/g, '');
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
    push(`0${ua.slice(4)}`); // 0XXXXXXXXX
  }

  push(trimmed);
  push(digits);

  // International without + if not already covered
  if (digits.startsWith('380') && digits.length === 12) {
    push(`+${digits}`);
  }

  return out;
}

export function buildIgNameSearchVariants(username: string): string[] {
  const u = normalizeIgUsername(username);
  if (!u) return [];
  return [u, `@${u}`];
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
};

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
 * PUT examples use phone/email arrays; POST examples use scalars.
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
  const body: Record<string, string | string[]> = { firstname, lastname };
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
