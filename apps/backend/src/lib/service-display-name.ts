/**
 * Human-readable service names for customer-facing booking copy.
 * Agents sometimes omit services[].name and only pass CRM UUIDs.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /^послуга\s*#/i;

/** True when the label is missing, a raw UUID, or `Послуга #<id>`. */
export function looksLikePlaceholderServiceName(
  name: string | undefined | null,
  serviceId?: string,
): boolean {
  const n = (name ?? '').trim();
  if (!n) return true;
  if (PLACEHOLDER_RE.test(n)) return true;
  if (UUID_RE.test(n)) return true;
  if (serviceId && n === `Послуга #${serviceId}`) return true;
  if (serviceId && n === serviceId) return true;
  return false;
}

/** Customer-facing text must never show CRM UUIDs. */
export function looksLikeServiceIdLeakInText(text: string): boolean {
  return (
    /послуга\s*#[0-9a-f-]{8,}/i.test(text) ||
    /service_id\s*[=:]/i.test(text) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)
  );
}

export function resolveServiceDisplayName(
  name: string | undefined | null,
  serviceId: string,
  catalogById: Map<string, string>,
): string {
  if (!looksLikePlaceholderServiceName(name, serviceId)) {
    return (name ?? '').trim();
  }
  const fromCatalog = catalogById.get(serviceId)?.trim();
  if (fromCatalog) return fromCatalog;
  return 'Послуга';
}

export function buildServiceNameCatalog(
  rows: Array<{ id: string; name: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.id && row.name?.trim()) map.set(row.id, row.name.trim());
  }
  return map;
}
