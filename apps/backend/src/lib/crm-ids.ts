/**
 * Normalize CRM entity ids from tool args / JSON (number or string → string).
 * BeautyPro uses UUIDs; CleverBOX uses numeric ids — both round-trip as strings.
 */

/** BeautyPro-style GUID (not strict RFC version nibble — live ids often fail uuid v4). */
export const CRM_GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** First UUID segment — models copy this from `[#88d8645d]` / `id.slice(0, 8)`. */
export const CRM_GUID_PREFIX_RE = /^[0-9a-f]{8}$/i;
export const CRM_NUMERIC_ID_RE = /^\d+$/;

export function asCrmId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function isCrmGuid(id: string): boolean {
  return CRM_GUID_RE.test(id.trim());
}

export function isCrmGuidPrefix(id: string): boolean {
  return CRM_GUID_PREFIX_RE.test(id.trim());
}

export function isCrmNumericId(id: string): boolean {
  return CRM_NUMERIC_ID_RE.test(id.trim());
}

export function crmProviderRequiresGuid(provider: string | null | undefined): boolean {
  return provider === 'beautypro';
}

export function crmProviderRequiresNumericId(provider: string | null | undefined): boolean {
  return provider === 'cleverbox';
}

/** Host-side expand/reject of tool ids before CRM POST (BeautyPro + CleverBOX). */
export function shouldResolveBookingCrmIds(provider: string | null | undefined): boolean {
  return crmProviderRequiresGuid(provider) || crmProviderRequiresNumericId(provider);
}

export type CrmIdNameHint = { id: string; name: string };

export type CrmIdResolveOk = { ok: true; id: string; expandedFrom?: string };
export type CrmIdResolveFail = {
  ok: false;
  raw: string;
  reason: 'truncated' | 'ambiguous' | 'not_guid' | 'not_numeric';
};

function nameKey(value: string): string {
  return value.trim().toLocaleLowerCase('uk');
}

function matchUniqueName(
  raw: string,
  names: Iterable<CrmIdNameHint> | undefined,
): { ok: true; id: string } | { ok: false; reason: 'ambiguous' } | null {
  if (!names) return null;
  const key = nameKey(raw);
  if (!key) return null;
  const hits = [
    ...new Set(
      [...names]
        .filter((n) => n.id.trim() && nameKey(n.name) === key)
        .map((n) => n.id.trim()),
    ),
  ];
  if (hits.length === 1) return { ok: true, id: hits[0]! };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' };
  return null;
}

/**
 * Expand a truncated / named tool id to a unique candidate from the slot offer
 * or catalog. BeautyPro: full GUID. CleverBOX: numeric id (unique name allowed).
 */
export function resolveCrmEntityId(
  raw: string,
  candidates: Iterable<string>,
  opts?: {
    requireGuid?: boolean;
    requireNumeric?: boolean;
    names?: Iterable<CrmIdNameHint>;
  },
): CrmIdResolveOk | CrmIdResolveFail {
  const id = raw.trim();
  if (!id) return { ok: false, raw, reason: 'not_guid' };

  const list = [
    ...new Set(
      [...candidates]
        .map((c) => (typeof c === 'string' ? c.trim() : ''))
        .filter((c) => c.length > 0),
    ),
  ];
  const exact = list.find((c) => c.toLowerCase() === id.toLowerCase());
  if (exact) {
    if (opts?.requireGuid && !isCrmGuid(exact)) {
      return { ok: false, raw: id, reason: 'not_guid' };
    }
    if (opts?.requireNumeric && !isCrmNumericId(exact)) {
      return { ok: false, raw: id, reason: 'not_numeric' };
    }
    return { ok: true, id: exact };
  }

  const byName = matchUniqueName(id, opts?.names);
  if (byName?.ok) {
    const resolved = byName.id;
    if (opts?.requireGuid && !isCrmGuid(resolved)) {
      return { ok: false, raw: id, reason: 'not_guid' };
    }
    if (opts?.requireNumeric && !isCrmNumericId(resolved)) {
      return { ok: false, raw: id, reason: 'not_numeric' };
    }
    return { ok: true, id: resolved, expandedFrom: id };
  }
  if (byName && !byName.ok) {
    return { ok: false, raw: id, reason: 'ambiguous' };
  }

  if (isCrmGuid(id)) {
    if (opts?.requireNumeric) return { ok: false, raw: id, reason: 'not_numeric' };
    return { ok: true, id };
  }

  const prefix = id.toLowerCase();
  const hits = list.filter((c) => {
    const lower = c.toLowerCase();
    if (!lower.startsWith(prefix) || lower.length <= prefix.length) return false;
    // Numeric CRM ids must not expand "1" → "15". GUID prefixes still map uniquely.
    if (opts?.requireNumeric && !isCrmGuid(c)) return false;
    return isCrmGuid(c) || lower.length > prefix.length;
  });
  if (hits.length === 1) {
    const expanded = hits[0]!;
    if (opts?.requireGuid && !isCrmGuid(expanded)) {
      return { ok: false, raw: id, reason: 'not_guid' };
    }
    if (opts?.requireNumeric && !isCrmNumericId(expanded)) {
      return { ok: false, raw: id, reason: 'not_numeric' };
    }
    return { ok: true, id: expanded, expandedFrom: id };
  }
  if (hits.length > 1) {
    return { ok: false, raw: id, reason: 'ambiguous' };
  }

  if (opts?.requireGuid || isCrmGuidPrefix(id)) {
    return {
      ok: false,
      raw: id,
      reason: isCrmGuidPrefix(id) ? 'truncated' : 'not_guid',
    };
  }

  if (opts?.requireNumeric) {
    if (isCrmNumericId(id)) return { ok: true, id };
    return { ok: false, raw: id, reason: 'not_numeric' };
  }

  return { ok: true, id };
}

export function formatInvalidCrmIdToolResult(fail: CrmIdResolveFail): string {
  const why =
    fail.reason === 'ambiguous'
      ? 'значення збігається з кількома id в офері/каталозі'
      : fail.reason === 'truncated'
        ? 'це лише перші 8 символів GUID, не повний id'
        : fail.reason === 'not_numeric'
          ? 'CleverBOX очікує числовий id, не імʼя і не GUID'
          : 'очікується повний id CRM, не імʼя і не короткий фрагмент';
  return [
    `[book_appointment] failed INVALID_CRM_ID — значення '${fail.raw}' (${why}).`,
    'Потрібен повний id з блоку «Запропоновані вікна» або з останнього search_services / get_available_slots (`[service_id=…]` / `[master_id=…]`): UUID для BeautyPro, число для CleverBOX.',
    'Не кажи клієнту що записано. Візьми повний id з сесії і виклич book_appointment знову.',
  ].join('\n');
}
