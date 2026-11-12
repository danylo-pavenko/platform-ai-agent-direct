const API_BASE = import.meta.env.VITE_API_URL || '/api';

/** Authenticated URL for a message attachment (storage key or legacy CDN URL). */
export function resolveMessageMediaSrc(key: string): string {
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key;
  }
  const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const path = `${API_BASE}/media/${encoded}`;
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) return path;
    return `${path}?access_token=${encodeURIComponent(token)}`;
  } catch {
    return path;
  }
}

export function isVideoMedia(key: string): boolean {
  return /\.(mp4|mov|webm)(\?|$)/i.test(key);
}

export function isAudioMedia(key: string): boolean {
  return /\.(m4a|aac|mp3|ogg|wav)(\?|$)/i.test(key);
}

export function isImageMedia(key: string): boolean {
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(key)) return true;
  // Meta IG messaging CDN (manager/client photos) — no file extension in the path.
  return isMetaMessagingCdnUrl(key);
}

/** Instagram messaging lookaside CDN (signed asset URLs without .jpg/.png). */
export function isMetaMessagingCdnUrl(key: string): boolean {
  if (!key.startsWith('http://') && !key.startsWith('https://')) return false;
  try {
    const u = new URL(key);
    const host = u.hostname.toLowerCase();
    if (host === 'lookaside.fbsbx.com' || host.endsWith('.fbsbx.com')) {
      return u.pathname.includes('ig_messaging_cdn') || u.searchParams.has('asset_id');
    }
    return false;
  } catch {
    return false;
  }
}
