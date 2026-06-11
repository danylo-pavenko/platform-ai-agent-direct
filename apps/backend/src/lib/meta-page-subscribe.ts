const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';
export const META_PAGE_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_seen',
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
