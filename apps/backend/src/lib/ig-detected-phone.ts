/**
 * Instagram often turns a typed phone into a second DM bubble: a tappable
 * "phone card" with empty `text`. The webhook then looks blank in admin even
 * though Meta parsed the number (fallback/unsupported/`tel:` payload).
 */

import { extractContactPatchesFromText } from './client-contact-heuristics.js';

const DETECTED_PHONE_PREFIX = '📞';
const MAX_WALK_DEPTH = 6;
const MAX_STRINGS = 40;

export interface MetaPhoneCardAttachment {
  type?: string;
  payload?: unknown;
}

export function formatIgDetectedPhoneText(phone: string): string {
  return `${DETECTED_PHONE_PREFIX} ${phone}`;
}

export function isIgDetectedPhoneText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return t.startsWith(DETECTED_PHONE_PREFIX);
}

function collectStringLeaves(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= MAX_STRINGS || depth > MAX_WALK_DEPTH) return out;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t) out.push(t);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, depth + 1, out);
      if (out.length >= MAX_STRINGS) break;
    }
    return out;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectStringLeaves(v, depth + 1, out);
    if (out.length >= MAX_STRINGS) break;
  }
  return out;
}

function decodeTelHref(raw: string): string {
  const trimmed = raw.trim();
  const tel = trimmed.match(/^tel:(.+)$/i);
  if (!tel?.[1]) return trimmed;
  try {
    return decodeURIComponent(tel[1]).replace(/^\/\//, '');
  } catch {
    return tel[1];
  }
}

/** Pull a UA mobile from attachment JSON / tel: URLs / titles. */
export function extractPhoneFromUnknownPayload(value: unknown): string | undefined {
  const leaves = collectStringLeaves(value).map(decodeTelHref);
  return extractContactPatchesFromText(leaves.join('\n')).phone;
}

export function extractPhoneFromMetaMessage(message: {
  text?: string;
  is_unsupported?: boolean;
  attachments?: MetaPhoneCardAttachment[];
  quick_reply?: { payload?: string };
}): string | undefined {
  const chunks: string[] = [];
  if (message.text?.trim()) chunks.push(message.text);
  if (message.quick_reply?.payload?.trim()) chunks.push(message.quick_reply.payload);
  for (const att of message.attachments ?? []) {
    if (att.type) chunks.push(att.type);
    if (att.payload !== undefined) {
      chunks.push(...collectStringLeaves(att.payload).map(decodeTelHref));
    }
  }
  return extractContactPatchesFromText(chunks.join('\n')).phone;
}

export function looksLikeIgAutoPhoneCard(opts: {
  text?: string | null;
  isUnsupported?: boolean;
  attachments?: MetaPhoneCardAttachment[];
  hasShare?: boolean;
  hasPlayableMedia?: boolean;
}): boolean {
  if ((opts.text ?? '').trim()) return false;
  if (opts.hasShare || opts.hasPlayableMedia) return false;
  if (opts.isUnsupported) return true;
  const atts = opts.attachments ?? [];
  if (atts.length === 0) return true;
  return atts.some((a) => {
    const t = (a.type ?? '').toLowerCase();
    return t === 'fallback' || t === 'template' || t === 'unsupported' || t === 'file';
  });
}

/** Same digits already present in earlier bubbles of this coalesced turn. */
export function isRedundantDetectedPhoneText(
  text: string,
  previousTexts: string[],
): boolean {
  const phone = extractContactPatchesFromText(text).phone;
  if (!phone) return false;
  const chip = isIgDetectedPhoneText(text) || looksLikeBarePhone(text);
  if (!chip) return false;
  return previousTexts.some(
    (prev) => extractContactPatchesFromText(prev).phone === phone,
  );
}

function looksLikeBarePhone(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^[\d\s+\-()]{9,16}$/u.test(t) || isIgDetectedPhoneText(t);
}
