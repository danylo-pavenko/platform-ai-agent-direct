/**
 * Detect client conversation language from inbound text (uk | en).
 * Returns null when the sample is too short / emoji-only / inconclusive.
 */

export type ClientLanguage = 'uk' | 'en';

const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const LATIN_RE = /[A-Za-z]/g;

export function normalizeClientLanguage(value: unknown): ClientLanguage | null {
  if (value === 'uk' || value === 'en') return value;
  return null;
}

/**
 * Heuristic: compare Cyrillic vs Latin letter counts.
 * Prefer uk when Cyrillic dominates; en when Latin dominates.
 */
export function detectClientLanguage(text: string): ClientLanguage | null {
  const sample = text.trim();
  if (sample.length < 2) return null;

  const cyr = (sample.match(CYRILLIC_RE) ?? []).join('').length;
  const lat = (sample.match(LATIN_RE) ?? []).join('').length;
  const letters = cyr + lat;
  if (letters < 3) return null;

  if (cyr >= lat * 1.2) return 'uk';
  if (lat >= cyr * 1.2) return 'en';
  // Tie / mixed → prefer uk (tenant default for UA salons)
  if (cyr > 0) return 'uk';
  if (lat > 0) return 'en';
  return null;
}
