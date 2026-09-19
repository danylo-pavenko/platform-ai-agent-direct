/**
 * Normalize CRM entity ids from tool args / JSON (number or string → string).
 * BeautyPro uses UUIDs; CleverBOX uses numeric ids — both round-trip as strings.
 */

/** BeautyPro-style GUID (not strict RFC version nibble — live ids often fail uuid v4). */
export const CRM_GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** First UUID segment — models copy this from `[#88d8645d]` / `id.slice(0, 8)`. */
export const CRM_GUID_PREFIX_RE = /^[0-9a-f]{8}$/i;

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

export function crmProviderRequiresGuid(provider: string | null | undefined): boolean {
  return provider === 'beautypro';
}

export type CrmIdResolveOk = { ok: true; id: string; expandedFrom?: string };
export type CrmIdResolveFail = {
  ok: false;
  raw: string;
  reason: 'truncated' | 'ambiguous' | 'not_guid';
};

/**
 * Expand an 8-char UUID prefix to a unique candidate, or accept a full GUID.
 * Ambiguous / unknown prefixes must not be sent to BeautyPro (HTTP 400 not a GUID).
 */
export function resolveCrmEntityId(
  raw: string,
  candidates: Iterable<string>,
  opts?: { requireGuid?: boolean },
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
    return { ok: true, id: exact };
  }

  if (isCrmGuid(id)) {
    return { ok: true, id };
  }

  const prefix = id.toLowerCase();
  const hits = list.filter((c) => {
    const lower = c.toLowerCase();
    return lower.startsWith(prefix) && (isCrmGuid(c) || lower.length > prefix.length);
  });
  if (hits.length === 1) {
    const expanded = hits[0]!;
    if (opts?.requireGuid && !isCrmGuid(expanded)) {
      return { ok: false, raw: id, reason: 'not_guid' };
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
  return { ok: true, id };
}

export function formatInvalidCrmIdToolResult(fail: CrmIdResolveFail): string {
  const why =
    fail.reason === 'ambiguous'
      ? 'префікс збігається з кількома UUID'
      : fail.reason === 'truncated'
        ? 'це лише перші 8 символів GUID, не повний id'
        : 'очікується повний GUID, не імʼя і не короткий фрагмент';
  return [
    `[book_appointment] failed INVALID_CRM_ID — значення '${fail.raw}' (${why}).`,
    'BeautyPro потребує ПОВНИЙ UUID з блоку «Запропоновані вікна» або з останнього search_services / get_available_slots (`[service_id=…]` / `[master_id=…]`).',
    'Не кажи клієнту що записано. Візьми повний id з сесії і виклич book_appointment знову.',
  ].join('\n');
}
