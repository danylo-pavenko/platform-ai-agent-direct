export interface GeoInfo {
  country: string | null;
  countryCode: string | null;
  region: string | null;
}

function isPrivateIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

/** Resolve country/region from request headers or ip-api.com fallback. */
export async function resolveGeo(
  ip: string,
  headers: Record<string, unknown>,
): Promise<GeoInfo> {
  const cfCountry = headers['cf-ipcountry'];
  if (typeof cfCountry === 'string' && cfCountry.length === 2 && cfCountry !== 'XX') {
    return { country: cfCountry, countryCode: cfCountry, region: null };
  }

  if (isPrivateIp(ip)) {
    return { country: null, countryCode: null, region: null };
  }

  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (!res.ok) return { country: null, countryCode: null, region: null };
    const data = (await res.json()) as {
      status?: string;
      country?: string;
      countryCode?: string;
      regionName?: string;
    };
    if (data.status !== 'success') return { country: null, countryCode: null, region: null };
    return {
      country: data.country ?? null,
      countryCode: data.countryCode ?? null,
      region: data.regionName ?? null,
    };
  } catch {
    return { country: null, countryCode: null, region: null };
  }
}
