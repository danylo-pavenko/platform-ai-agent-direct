/** UI placeholder for secrets already stored server-side (must never be persisted). */
const MASK_PREFIX = '••••••';

export function isMaskedIntegrationSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === MASK_PREFIX || trimmed.startsWith(MASK_PREFIX);
}

/** Bearer tokens must be Latin-1 (fetch Header ByteString constraint). */
export function isHttpHeaderSafeToken(value: string): boolean {
  if (!value) return false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false;
  }
  return true;
}

export function sanitizeIntegrationSecret(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || isMaskedIntegrationSecret(trimmed)) return '';
  if (!isHttpHeaderSafeToken(trimmed)) return '';
  return trimmed;
}
