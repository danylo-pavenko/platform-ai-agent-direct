/**
 * Strip Unicode control / zero-width characters that could be used
 * for prompt injection or invisible text manipulation.
 *
 * Removed ranges:
 *  - U+200B–U+200F  (zero-width space, joiners, LTR/RTL marks)
 *  - U+202A–U+202E  (bidi embedding/override)
 *  - U+FEFF          (BOM / zero-width no-break space)
 */
const CONTROL_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

/** Matches markdown code fences (``` with optional language tag) */
const CODE_FENCE_RE = /```[\s\S]*?```/g;

/**
 * Sanitize a client message before it reaches Claude.
 *
 * - Strips invisible Unicode control characters
 * - Strips markdown code fences (potential injection vector)
 * - Trims whitespace
 */
export function sanitizeMessage(text: string): string {
  return text
    .replace(CONTROL_CHARS_RE, '')
    .replace(CODE_FENCE_RE, '')
    .trim();
}

/**
 * Patterns that look like prompt-injection attempts.
 * Case-insensitive matching.
 */
const INJECTION_PATTERNS = [
  /ignore\s+previous/i,
  /\bsystem\s*:/i,
  /\[INST\]/i,
  /\bHuman\s*:/i,
  /\bAssistant\s*:/i,
];

/**
 * Detect obvious prompt-injection attempts.
 *
 * Returns `true` if any known injection pattern is found.
 * Intended for logging/alerting - messages are NOT blocked.
 */
export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Regex matching card-number-like digit sequences (13–19 digits).
 * Uses word boundaries to avoid matching within longer numbers.
 */
const CARD_NUMBER_RE = /\b\d{13,19}\b/g;

/**
 * Replace card-number-like sequences with `[REDACTED]`
 * to prevent accidental persistence of sensitive data.
 */
export function redactSensitive(text: string): string {
  return text.replace(CARD_NUMBER_RE, '[REDACTED]');
}
