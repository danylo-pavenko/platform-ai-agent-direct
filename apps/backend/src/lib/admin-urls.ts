import { config } from '../config.js';

export function adminConversationUrl(conversationId: string): string {
  const base = config.ADMIN_DOMAIN.startsWith('http')
    ? config.ADMIN_DOMAIN.replace(/\/$/, '')
    : `https://${config.ADMIN_DOMAIN}`;
  return `${base}/conversations/${conversationId}`;
}

export function adminSettingsUrl(): string {
  const base = config.ADMIN_DOMAIN.startsWith('http')
    ? config.ADMIN_DOMAIN.replace(/\/$/, '')
    : `https://${config.ADMIN_DOMAIN}`;
  return `${base}/settings`;
}

/** Deep-link to Settings → Claude auth card (`#settings-claude` in admin UI). */
export function adminClaudeAuthSettingsUrl(): string {
  return `${adminSettingsUrl()}#settings-claude`;
}
