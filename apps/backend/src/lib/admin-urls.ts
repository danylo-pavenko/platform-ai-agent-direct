import { config } from '../config.js';

export function adminConversationUrl(conversationId: string): string {
  const base = config.ADMIN_DOMAIN.startsWith('http')
    ? config.ADMIN_DOMAIN.replace(/\/$/, '')
    : `https://${config.ADMIN_DOMAIN}`;
  return `${base}/conversations/${conversationId}`;
}
