const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';
/**
 * Page `subscribed_fields` that Graph still accepts (v25).
 * `messaging_seen` is rejected: (#100) subscribed_fields[n] must be one of
 * {messages, message_reactions, standby, messaging_postbacks, …}.
 * A single invalid field fails the whole POST — webhooks never attach.
 */
export const META_PAGE_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_reactions',
  'standby',
] as const;
const WEBHOOK_FIELDS = META_PAGE_WEBHOOK_FIELDS.join(',');

export async function getPageWebhookSubscription(
  pageId: string,
  pageAccessToken: string,
): Promise<{ ok: boolean; subscribed: boolean; fields: string[]; status?: number; body?: string }> {
  const url = new URL(`${FB_GRAPH_BASE}/${pageId}/subscribed_apps`);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${pageAccessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, subscribed: false, fields: [], status: res.status, body: body.slice(0, 300) };
  }

  let parsed: { data?: Array<{ subscribed_fields?: string[] }> } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { ok: true, subscribed: false, fields: [], body: body.slice(0, 300) };
  }

  const fields = new Set<string>();
  for (const row of parsed.data ?? []) {
    for (const f of row.subscribed_fields ?? []) fields.add(f);
  }
  const fieldList = [...fields];
  const subscribed = META_PAGE_WEBHOOK_FIELDS.every((f) => fields.has(f));

  return { ok: true, subscribed, fields: fieldList };
}

export async function subscribePageToMetaWebhooks(
  pageId: string,
  pageAccessToken: string,
): Promise<{ ok: boolean; status?: number; body?: string }> {
  const subUrl = new URL(`${FB_GRAPH_BASE}/${pageId}/subscribed_apps`);
  subUrl.searchParams.set('subscribed_fields', WEBHOOK_FIELDS);

  const subRes = await fetch(subUrl.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${pageAccessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  const body = await subRes.text().catch(() => '');
  return { ok: subRes.ok, status: subRes.status, body: body.slice(0, 300) };
}

export type WebhookSubscribePostResult = {
  ok: boolean;
  status?: number;
  body?: string;
};

export type WebhookSubscribeReadResult = {
  ok: boolean;
  subscribed: boolean;
  fields: string[];
  status?: number;
  body?: string;
  readForbidden: boolean;
};

export type WebhookSubscribeCheckResult = {
  pageId: string;
  post: WebhookSubscribePostResult;
  read?: WebhookSubscribeReadResult;
  /** True when Meta accepted POST. GET 403 does not override this. */
  subscribeOk: boolean;
  messageUk: string;
};

/** Human-readable outcome for tenant admin (POST is the source of truth). */
export function formatWebhookSubscribeMessage(opts: {
  postOk: boolean;
  postStatus?: number;
  postBody?: string;
  readOk?: boolean;
  readStatus?: number;
  readForbidden?: boolean;
  subscribed?: boolean;
}): string {
  if (!opts.postOk) {
    const detail = [
      opts.postStatus != null ? `HTTP ${opts.postStatus}` : null,
      opts.postBody?.trim() || null,
    ]
      .filter(Boolean)
      .join(' — ');
    return detail
      ? `Підписка webhook не пройшла: ${detail}`
      : 'Підписка webhook не пройшла (POST /{page-id}/subscribed_apps).';
  }
  if (opts.readForbidden) {
    return (
      'Підписка webhook на Page пройшла успішно (POST). ' +
      'Перевірка списку полів (GET) недоступна без pages_manage_metadata — це очікувано.'
    );
  }
  if (opts.readOk && opts.subscribed) {
    return 'Підписка webhook на Page пройшла успішно. Усі поля активні.';
  }
  if (opts.readOk && !opts.subscribed) {
    return 'POST підписки пройшов, але Graph не показує всі поля (messages, standby, …).';
  }
  return 'Підписка webhook на Page пройшла успішно (POST subscribed_apps).';
}

/** POST subscribe, then best-effort GET. Used by admin «Перевірити підписку webhook». */
export async function runPageWebhookSubscribe(
  pageId: string,
  pageAccessToken: string,
): Promise<WebhookSubscribeCheckResult> {
  const post = await subscribePageToMetaWebhooks(pageId, pageAccessToken);
  let read: WebhookSubscribeReadResult | undefined;
  if (post.ok) {
    const sub = await getPageWebhookSubscription(pageId, pageAccessToken);
    read = {
      ok: sub.ok,
      subscribed: sub.subscribed,
      fields: sub.fields,
      status: sub.status,
      body: sub.body,
      readForbidden: sub.status === 403,
    };
  }
  return {
    pageId,
    post,
    read,
    subscribeOk: post.ok,
    messageUk: formatWebhookSubscribeMessage({
      postOk: post.ok,
      postStatus: post.status,
      postBody: post.body,
      readOk: read?.ok,
      readStatus: read?.status,
      readForbidden: read?.readForbidden,
      subscribed: read?.subscribed,
    }),
  };
}
