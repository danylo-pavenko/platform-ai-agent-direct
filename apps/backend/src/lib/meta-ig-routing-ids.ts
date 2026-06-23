const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

interface IgNodeFields {
  id?: string;
  ig_id?: string | number;
  username?: string;
}

interface PageIgFields {
  instagram_business_account?: IgNodeFields;
}

function addIgRoutingIds(ids: Set<string>, ig?: IgNodeFields | null): void {
  if (!ig) return;
  if (ig.id) ids.add(String(ig.id));
  if (ig.ig_id != null && ig.ig_id !== '') ids.add(String(ig.ig_id));
}

async function graphProbe(
  path: string,
  fields: string,
  pageAccessToken: string,
): Promise<(IgNodeFields & PageIgFields) | null> {
  try {
    const url = new URL(`${FB_GRAPH_BASE}/${path}`);
    url.searchParams.set('fields', fields);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as IgNodeFields & PageIgFields;
  } catch {
    return null;
  }
}

/**
 * Collect every Instagram account ID that may appear in webhook payloads.
 * Graph `instagram_business_account.id` (178414…) often differs from
 * `recipient.id` in messaging webhooks — query `ig_id` on the IG node.
 *
 * Direct GET /{ig-id} often returns 400 with a Page token; probing via
 * /{page-id} or /me is more reliable.
 */
export async function resolveInstagramWebhookRoutingIds(
  igBusinessAccountId: string,
  pageAccessToken: string,
  pageId?: string,
): Promise<string[]> {
  const ids = new Set<string>();
  if (igBusinessAccountId) ids.add(igBusinessAccountId);
  // Page ID sometimes appears as recipient.id in Meta messaging webhooks.
  if (pageId) ids.add(pageId);

  const pageFields = 'instagram_business_account{id,ig_id,username}';

  if (pageId) {
    const fromPage = await graphProbe(pageId, pageFields, pageAccessToken);
    addIgRoutingIds(ids, fromPage?.instagram_business_account);
  }

  const fromMe = await graphProbe('me', pageFields, pageAccessToken);
  addIgRoutingIds(ids, fromMe?.instagram_business_account);

  if (igBusinessAccountId) {
    const fromIg = await graphProbe(igBusinessAccountId, 'id,ig_id,username', pageAccessToken);
    addIgRoutingIds(ids, fromIg);
  }

  return [...ids];
}
