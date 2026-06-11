const FB_GRAPH_BASE = 'https://graph.facebook.com/v22.0';
const WEBHOOK_FIELDS = 'messages,messaging_postbacks,messaging_seen,standby';

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
