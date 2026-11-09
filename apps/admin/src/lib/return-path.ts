/** Internal path to reopen after a session expiry. Rejects open redirects and /login. */

export function safeReturnPath(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (trimmed.includes('\\') || trimmed.includes('://')) return null;

  let pathname = trimmed;
  try {
    const url = new URL(trimmed, 'http://local.invalid');
    if (url.origin !== 'http://local.invalid') return null;
    pathname = url.pathname;
  } catch {
    return null;
  }

  if (pathname === '/login' || pathname.startsWith('/login/')) return null;
  return trimmed;
}
