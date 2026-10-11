/**
 * Altegio HTTP.
 *
 * Business Management v2 (`/api/v2`): services, team members, appointments,
 * delete. Auth: `Bearer {partner}, User {user}` and
 * `Accept: application/vnd.api.v2+json`.
 * https://developer.alteg.io/en/b2b-v2/openapi
 *
 * Online Booking stays on `/api/v1`: book_dates, book_times, and
 * POST /records (v2 has no individual-appointment create and no free slots).
 * B2B v3 is still a preview — do not call `/api/v3`.
 *
 * Array query keys stay literal `service_ids[]`. `include` is repeated
 * without brackets (`include=services&include=staff`).
 */

/** Business Management. */
export const ALTEGIO_B2B_BASE = 'https://api.alteg.io/api/v2';
/** Online Booking and the staff record create/update that v2 does not expose. */
export const ALTEGIO_BOOKING_BASE = 'https://api.alteg.io/api/v1';
/** @deprecated Use ALTEGIO_BOOKING_BASE. Kept so older call sites stay pointed at booking. */
export const ALTEGIO_API_BASE = ALTEGIO_BOOKING_BASE;

export type AltegioAuth = {
  partnerToken: string;
  userToken: string;
};

export type AltegioFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class AltegioHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AltegioHttpError';
  }
}

export function serializeAltegioQuery(
  params?: Record<string, unknown> | null,
): string {
  if (!params) return '';
  const parts: string[] = [];
  const push = (key: string, value: string) => {
    parts.push(`${key}=${encodeURIComponent(value)}`);
  };

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const arrayKey = key === 'include' || key.endsWith('[]') ? key : `${key}[]`;
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        push(arrayKey, String(item));
      }
    } else if (typeof value === 'boolean') {
      push(key, value ? '1' : '0');
    } else {
      push(key, String(value));
    }
  }
  return parts.join('&');
}

function scrub(message: string, auth: AltegioAuth): string {
  let out = message;
  if (auth.partnerToken) out = out.split(auth.partnerToken).join('[token]');
  if (auth.userToken) out = out.split(auth.userToken).join('[token]');
  return out.slice(0, 240);
}

function errorMessage(status: number, json: unknown, auth: AltegioAuth): string {
  const meta =
    json && typeof json === 'object'
      ? (json as { meta?: { message?: unknown }; message?: unknown }).meta?.message
        ?? (json as { message?: unknown }).message
      : undefined;
  const raw = typeof meta === 'string' ? scrub(meta, auth) : '';
  if (status === 401) {
    return raw || 'Altegio відхилив токен (401). Перевірте partner token і user token.';
  }
  if (status === 403) {
    return raw || 'Altegio: немає доступу до цієї компанії (403).';
  }
  if (status === 429) return 'Altegio: перевищено ліміт запитів (429).';
  return raw || `Altegio HTTP ${status}`;
}

export class AltegioClient {
  constructor(
    private readonly auth: AltegioAuth,
    private readonly fetchImpl: AltegioFetcher = fetch,
  ) {}

  /** Business Management v2. */
  b2bGet<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>(this.url(ALTEGIO_B2B_BASE, path, query), { method: 'GET' });
  }

  b2bDelete(path: string): Promise<void> {
    return this.request<unknown>(this.url(ALTEGIO_B2B_BASE, path), { method: 'DELETE' }).then(
      () => undefined,
    );
  }

  /** Online Booking / staff records on `/api/v1`. */
  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>(this.url(ALTEGIO_BOOKING_BASE, path, query), { method: 'GET' });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(this.url(ALTEGIO_BOOKING_BASE, path), {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(this.url(ALTEGIO_BOOKING_BASE, path), {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async delete(path: string): Promise<void> {
    await this.request<unknown>(this.url(ALTEGIO_BOOKING_BASE, path), {
      method: 'DELETE',
    });
  }

  private url(base: string, path: string, query?: Record<string, unknown>): string {
    const qs = serializeAltegioQuery(query);
    return `${base}/${path.replace(/^\//, '')}${qs ? `?${qs}` : ''}`;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.api.v2+json',
      Authorization: `Bearer ${this.auth.partnerToken}, User ${this.auth.userToken}`,
    };
    if (init.body) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AltegioHttpError(scrub(message, this.auth) || 'Altegio недоступний', 0);
    }

    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }

    const failed =
      !response.ok
      || (json != null
        && typeof json === 'object'
        && (json as { success?: unknown }).success === false);

    if (failed) {
      throw new AltegioHttpError(
        errorMessage(response.status, json, this.auth),
        response.status,
      );
    }

    return (json ?? {}) as T;
  }
}
