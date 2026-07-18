/**
 * Normalize CRM entity ids from tool args / JSON (number or string → string).
 * BeautyPro uses UUIDs; CleverBOX uses numeric ids — both round-trip as strings.
 */

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
