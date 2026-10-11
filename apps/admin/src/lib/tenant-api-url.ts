/**
 * Public tenant API origin derived from the admin hostname.
 * agent.example.com → api.example.com
 * agent-{id}.base → api-{id}.base
 */

const SAVED_SECRET = '••••••';

export function resolveApiHostFromAdmin(hostname: string): string {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return hostname;
  if (hostname.startsWith('agent.')) return hostname.replace(/^agent\./, 'api.');
  const platform = hostname.match(/^agent-([a-z0-9-]+)\.(.+)$/i);
  if (platform) return `api-${platform[1]}.${platform[2]}`;
  return hostname;
}

export function tenantApiOrigin(hostname: string): string {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3000';
  return `https://${resolveApiHostFromAdmin(hostname)}`;
}

/** Exact POST URL this tenant pastes into Altegio callback settings. */
export function altegioWebhookUrl(hostname: string, webhookSecret?: string): string {
  const base = `${tenantApiOrigin(hostname)}/webhooks/altegio`;
  const secret = webhookSecret?.trim() ?? '';
  if (!secret || secret === SAVED_SECRET || secret.startsWith(SAVED_SECRET)) return base;
  return `${base}?token=${encodeURIComponent(secret)}`;
}
