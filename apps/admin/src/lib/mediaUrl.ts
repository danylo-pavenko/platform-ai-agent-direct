const API_BASE = import.meta.env.VITE_API_URL || '/api';

/** Authenticated URL for a message attachment (storage key or legacy CDN URL). */
export function resolveMessageMediaSrc(key: string): string {
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key;
  }
  const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const path = `${API_BASE}/media/${encoded}`;
  const token = localStorage.getItem('token');
  if (!token) return path;
  return `${path}?access_token=${encodeURIComponent(token)}`;
}

export function isVideoMedia(key: string): boolean {
  return /\.(mp4|mov|webm)(\?|$)/i.test(key);
}

export function isAudioMedia(key: string): boolean {
  return /\.(m4a|aac|mp3|ogg|wav)(\?|$)/i.test(key);
}

export function isImageMedia(key: string): boolean {
  return /\.(jpe?g|png|gif|webp)(\?|$)/i.test(key);
}
