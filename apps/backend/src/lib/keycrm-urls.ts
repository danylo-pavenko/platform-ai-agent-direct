import { getIntegrationConfig } from './integration-config.js';
import { config } from '../config.js';

/** Normalize tenant KeyCRM web URL (Settings or .env). Returns null when unset/invalid. */
export function normalizeKeycrmAppUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Resolved per-tenant app URL: DB Settings → optional .env fallback. */
export async function resolveKeycrmAppUrl(): Promise<string | null> {
  const { keycrm } = await getIntegrationConfig();
  return (
    normalizeKeycrmAppUrl(keycrm.appUrl) ??
    normalizeKeycrmAppUrl(config.KEYCRM_APP_URL)
  );
}

/** Deep link to view an order in KeyCRM — null when app URL is not configured. */
export function buildKeycrmOrderUrl(
  keycrmOrderId: string | number,
  appUrl: string | null,
): string | null {
  if (!appUrl) return null;
  const base = appUrl.replace(/\/$/, '');
  return `${base}/app/orders/view/${keycrmOrderId}`;
}
