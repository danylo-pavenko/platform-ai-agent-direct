import { config } from '../config.js';

/** Absolute base for tenant API (Meta must fetch library assets from here). */
export function apiPublicBaseUrl(): string {
  const raw = config.API_DOMAIN.trim();
  if (!raw || raw === 'localhost') {
    return `http://127.0.0.1:${config.API_PORT}`;
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/$/, '');
  }
  return `https://${raw.replace(/\/$/, '')}`;
}
