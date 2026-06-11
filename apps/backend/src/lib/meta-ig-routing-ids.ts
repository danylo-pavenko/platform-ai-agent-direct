const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

/**
 * Collect every Instagram account ID that may appear in webhook payloads.
 * Graph `instagram_business_account.id` (178414…) often differs from
 * `recipient.id` in messaging webhooks — query `ig_id` on the IG node.
 */
export async function resolveInstagramWebhookRoutingIds(
  igBusinessAccountId: string,
  pageAccessToken: string,
): Promise<string[]> {
  const ids = new Set<string>();
  if (igBusinessAccountId) ids.add(igBusinessAccountId);

  try {
    const url = new URL(`${FB_GRAPH_BASE}/${igBusinessAccountId}`);
    url.searchParams.set('fields', 'id,ig_id,username');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { id?: string; ig_id?: string | number };
      if (data.id) ids.add(String(data.id));
      if (data.ig_id != null && data.ig_id !== '') ids.add(String(data.ig_id));
    }
  } catch {
    /* non-fatal — primary id still synced */
  }

  return [...ids];
}
