import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import {
  getIntegrationConfig,
  invalidateIntegrationConfigCache,
} from '../lib/integration-config.js';
import { config } from '../config.js';
import {
  checkIgConnectionStatus,
  importRecentIgConversations,
} from '../services/ig-connection.js';
import { probeInstagramManageComments } from '../services/ig-comments-probe.js';
import {
  runPageWebhookSubscribe,
  subscribePageToMetaWebhooks,
} from '../lib/meta-page-subscribe.js';
import { clearWebhookRoutingOnHub, syncWebhookRoutingToHub } from '../lib/webhook-hub-sync.js';
import {
  createHubOAuthState,
  isHubOAuthState,
  resolveOAuthRedirectUri,
  usesCentralOAuthHub,
  verifyHubOAuthState,
} from '../lib/meta-oauth-hub.js';

// ── Facebook Login for Business endpoints ────────────────────────────────────
const FB_AUTHORIZE_URL = 'https://www.facebook.com/dialog/oauth';
const FB_TOKEN_URL = 'https://graph.facebook.com/oauth/access_token';
const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

// Scopes for Instagram Business messaging via Facebook Login (align with App Review).
// instagram_basic is intentionally omitted: it belongs to the deprecated
// Instagram Basic Display API (personal accounts) and is wrong for Messenger
// Platform / Business Messaging.
// pages_manage_metadata is NOT a valid Facebook Login OAuth scope (Meta rejects it);
// webhook subscription (POST /{page-id}/subscribed_apps) works without it when
// the authorizing user is the Page admin.
const FB_SCOPES = [
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'instagram_manage_messages',
  // App Review / comment moderation test calls (GET /{ig-media-id}/comments).
  // Not used for DM routing — see probeInstagramManageComments.
  'instagram_manage_comments',
].join(',');

// ── State store (in-memory, expires in 10 min) ───────────────────────────────
const pendingStates = new Map<string, { expiresAt: number }>();

function generateState(redirectUri: string): string {
  if (usesCentralOAuthHub(redirectUri)) {
    if (!config.SUPERVISOR_SHARED_SECRET) {
      throw new Error('SUPERVISOR_SHARED_SECRET is required for platform OAuth hub');
    }
    return createHubOAuthState(config.INSTANCE_ID, config.SUPERVISOR_SHARED_SECRET);
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 });
  for (const [k, v] of pendingStates) {
    if (v.expiresAt < Date.now()) pendingStates.delete(k);
  }
  return state;
}

function consumeState(state: string): boolean {
  if (isHubOAuthState(state)) {
    return verifyHubOAuthState(state, config.INSTANCE_ID, config.SUPERVISOR_SHARED_SECRET);
  }
  const entry = pendingStates.get(state);
  if (!entry || entry.expiresAt < Date.now()) return false;
  pendingStates.delete(state);
  return true;
}

function getApiBaseUrl(): string {
  if (config.API_DOMAIN === 'localhost') {
    return `http://localhost:${config.API_PORT}`;
  }
  return `https://${config.API_DOMAIN}`;
}

interface MetaPageRow {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}

/** Safe page list for logs — never includes access_token. */
function summarizePagesList(pages: MetaPageRow[]) {
  return pages.map((p) => ({
    pageId: p.id,
    pageName: p.name,
    hasInstagram: Boolean(p.instagram_business_account?.id),
    igUserId: p.instagram_business_account?.id ?? null,
    igUsername: p.instagram_business_account?.username ?? null,
  }));
}

const PAGE_LIST_FIELDS =
  'id,name,access_token,instagram_business_account{id,username,name},connected_instagram_account{id,username,name}';
const PAGE_IG_FIELDS =
  'instagram_business_account{id,username,name},connected_instagram_account{id,username,name}';

/** Graph debug_token — scopes / validity (no secret values). */
async function debugFacebookToken(
  inputToken: string,
  appId: string,
  appSecret: string,
): Promise<Record<string, unknown>> {
  try {
    const debugUrl = new URL(`${FB_GRAPH_BASE}/debug_token`);
    debugUrl.searchParams.set('input_token', inputToken);
    debugUrl.searchParams.set('access_token', `${appId}|${appSecret}`);
    const res = await fetch(debugUrl.toString(), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return { httpStatus: res.status };
    }
    const json = (await res.json()) as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    return {
      isValid: d.is_valid,
      type: d.type,
      appId: d.app_id,
      userId: d.user_id,
      expiresAt: d.expires_at,
      scopes: d.scopes,
      granularScopes: d.granular_scopes,
      error: d.error,
    };
  } catch (err) {
    return { probeError: err instanceof Error ? err.message : String(err) };
  }
}

type IgBusinessAccount = NonNullable<MetaPageRow['instagram_business_account']>;

async function graphGetJson<T>(
  url: string,
  accessToken: string,
): Promise<{ ok: boolean; data?: T }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false };
  }
}

function pickIgAccount(data?: {
  instagram_business_account?: IgBusinessAccount;
  connected_instagram_account?: IgBusinessAccount;
}): IgBusinessAccount | undefined {
  const ig = data?.instagram_business_account ?? data?.connected_instagram_account;
  return ig?.id ? ig : undefined;
}

async function probePageInstagram(
  pageId: string,
  accessToken: string,
): Promise<IgBusinessAccount | undefined> {
  const url = new URL(`${FB_GRAPH_BASE}/${pageId}`);
  url.searchParams.set('fields', PAGE_IG_FIELDS);
  const res = await graphGetJson<{
    instagram_business_account?: IgBusinessAccount;
    connected_instagram_account?: IgBusinessAccount;
  }>(url.toString(), accessToken);
  return pickIgAccount(res.data);
}

/** Page token /me often exposes instagram_business_account when /{page-id} does not. */
async function probeMeInstagram(accessToken: string): Promise<IgBusinessAccount | undefined> {
  const url = new URL(`${FB_GRAPH_BASE}/me`);
  url.searchParams.set('fields', PAGE_IG_FIELDS);
  const res = await graphGetJson<{
    instagram_business_account?: IgBusinessAccount;
    connected_instagram_account?: IgBusinessAccount;
  }>(url.toString(), accessToken);
  return pickIgAccount(res.data);
}

async function probeIgUsername(
  igUserId: string,
  accessToken: string,
): Promise<string | undefined> {
  const url = new URL(`${FB_GRAPH_BASE}/${igUserId}`);
  url.searchParams.set('fields', 'username');
  const res = await graphGetJson<{ username?: string }>(url.toString(), accessToken);
  return res.data?.username;
}

/**
 * Meta sometimes omits instagram_business_account on /me/accounts batch responses
 * even when the Page↔IG link exists. Probe each Page directly, then scan Business
 * Portfolio pages (requires business_management — already in our OAuth scopes).
 */
async function resolvePagesWithInstagram(
  pages: MetaPageRow[],
  userAccessToken: string,
): Promise<{ pages: MetaPageRow[]; businessOnlyPages: Array<{ id: string; name: string; igUsername: string | null }> }> {
  const byId = new Map<string, MetaPageRow>(pages.map((p) => [p.id, { ...p }]));

  for (const p of byId.values()) {
    if (p.instagram_business_account?.id) continue;
    const ig = await probePageInstagram(p.id, userAccessToken);
    if (ig?.id) p.instagram_business_account = ig;
  }

  const businessOnlyPages: Array<{ id: string; name: string; igUsername: string | null }> = [];

  try {
    const bizUrl = new URL(`${FB_GRAPH_BASE}/me/businesses`);
    bizUrl.searchParams.set('fields', 'id,name');
    const bizRes = await fetch(bizUrl.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const bizData = (await bizRes.json()) as { data?: Array<{ id: string; name: string }> };

    for (const biz of bizData.data ?? []) {
      for (const edge of ['owned_pages', 'client_pages'] as const) {
        const edgeUrl = new URL(`${FB_GRAPH_BASE}/${biz.id}/${edge}`);
        edgeUrl.searchParams.set('fields', `id,name,${PAGE_IG_FIELDS}`);
        const edgeRes = await fetch(edgeUrl.toString(), {
          headers: { Authorization: `Bearer ${userAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!edgeRes.ok) continue;
        const edgeData = (await edgeRes.json()) as { data?: MetaPageRow[] };
        for (const row of edgeData.data ?? []) {
          const ig = row.instagram_business_account;
          const existing = byId.get(row.id);
          if (existing) {
            if (!existing.instagram_business_account?.id && ig?.id) {
              existing.instagram_business_account = ig;
            }
          } else if (ig?.id) {
            businessOnlyPages.push({
              id: row.id,
              name: row.name,
              igUsername: ig.username ?? null,
            });
          }
        }
      }
    }
  } catch {
    /* non-fatal enrichment */
  }

  return { pages: [...byId.values()], businessOnlyPages };
}

const IG_RELATED_SCOPES = new Set([
  'instagram_manage_messages',
  'instagram_business_manage_messages',
  'instagram_manage_comments',
]);

const PAGE_RELATED_SCOPES = new Set(['pages_show_list', 'pages_read_engagement']);

function extractTargetIdsFromGranularScopes(
  tokenDebug: Record<string, unknown>,
  scopeFilter: (scope: string) => boolean,
): string[] {
  const granular = tokenDebug.granularScopes;
  if (!Array.isArray(granular)) return [];
  const ids = new Set<string>();
  for (const row of granular) {
    if (!row || typeof row !== 'object') continue;
    const scope = String((row as { scope?: string }).scope ?? '');
    if (!scopeFilter(scope)) continue;
    const targets = (row as { target_ids?: string[] }).target_ids;
    if (Array.isArray(targets)) {
      for (const id of targets) {
        if (typeof id === 'string' && id.length > 0) ids.add(id);
      }
    }
  }
  return [...ids];
}

/** IG account IDs the user explicitly selected in the granular OAuth dialog. */
function extractIgTargetIdsFromTokenDebug(tokenDebug: Record<string, unknown>): string[] {
  return extractTargetIdsFromGranularScopes(
    tokenDebug,
    (scope) => IG_RELATED_SCOPES.has(scope) || scope.startsWith('instagram_'),
  );
}

/** Page IDs granted in the granular OAuth dialog (pages_show_list, etc.). */
function extractPageTargetIdsFromTokenDebug(tokenDebug: Record<string, unknown>): string[] {
  return extractTargetIdsFromGranularScopes(
    tokenDebug,
    (scope) => PAGE_RELATED_SCOPES.has(scope) || scope.startsWith('pages_'),
  );
}

/**
 * Granular OAuth returns Page and IG target_ids separately; /me/accounts often omits
 * instagram_business_account. Auto-pair only when exactly one Page was granted —
 * several Pages must go through the picker (otherwise we may attach IG to the wrong Page).
 */
function resolvePageFromGranularTargetIds(
  pages: MetaPageRow[],
  tokenDebug: Record<string, unknown>,
): MetaPageRow | null {
  const igIds = extractIgTargetIdsFromTokenDebug(tokenDebug);
  const pageIds = extractPageTargetIdsFromTokenDebug(tokenDebug);
  if (igIds.length === 0 || pageIds.length !== 1) return null;

  const pageId = pageIds[0];
  const pageRow = pages.find((p) => p.id === pageId && p.access_token);
  if (!pageRow) return null;
  return {
    ...pageRow,
    instagram_business_account: {
      id: igIds[0],
      username: pageRow.instagram_business_account?.username,
    },
  };
}

async function listInstagramAccountIdsFromBusinesses(userAccessToken: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const bizUrl = new URL(`${FB_GRAPH_BASE}/me/businesses`);
    bizUrl.searchParams.set('fields', 'id');
    const bizRes = await fetch(bizUrl.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!bizRes.ok) return [];
    const bizData = (await bizRes.json()) as { data?: Array<{ id: string }> };

    for (const biz of bizData.data ?? []) {
      for (const edge of [
        'owned_instagram_accounts',
        'instagram_accounts',
        'client_instagram_accounts',
      ] as const) {
        const edgeUrl = new URL(`${FB_GRAPH_BASE}/${biz.id}/${edge}`);
        edgeUrl.searchParams.set('fields', 'id,username');
        const edgeRes = await fetch(edgeUrl.toString(), {
          headers: { Authorization: `Bearer ${userAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!edgeRes.ok) continue;
        const edgeData = (await edgeRes.json()) as { data?: Array<{ id: string }> };
        for (const ig of edgeData.data ?? []) {
          if (ig.id) ids.add(ig.id);
        }
      }
    }
  } catch {
    /* non-fatal */
  }
  return [...ids];
}

async function fetchIgUserConnectedPage(
  igUserId: string,
  userAccessToken: string,
): Promise<{
  igUserId: string;
  igUsername?: string;
  pageId?: string;
  pageName?: string;
  httpStatus?: number;
  graphError?: string;
} | null> {
  const url = new URL(`${FB_GRAPH_BASE}/${igUserId}`);
  url.searchParams.set('fields', 'id,username,name,connected_facebook_page{id,name}');
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      id?: string;
      username?: string;
      connected_facebook_page?: { id?: string; name?: string };
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        igUserId,
        httpStatus: res.status,
        graphError: data.error?.message,
      };
    }
    return {
      igUserId,
      igUsername: data.username,
      pageId: data.connected_facebook_page?.id,
      pageName: data.connected_facebook_page?.name,
    };
  } catch {
    return null;
  }
}

/**
 * When the user picks Instagram accounts in the granular OAuth dialog, Graph often
 * omits instagram_business_account on /me/accounts. Prefer pairing target_ids from
 * debug_token; fall back to connected_facebook_page only when page ids are missing.
 */
async function resolvePageFromSelectedInstagramAccounts(
  userAccessToken: string,
  pages: MetaPageRow[],
  tokenDebug: Record<string, unknown>,
): Promise<MetaPageRow | null> {
  const fromGranular = resolvePageFromGranularTargetIds(pages, tokenDebug);
  if (fromGranular) return fromGranular;

  let igIds = extractIgTargetIdsFromTokenDebug(tokenDebug);
  if (igIds.length === 0) {
    igIds = await listInstagramAccountIdsFromBusinesses(userAccessToken);
  }

  for (const igUserId of igIds) {
    const linked = await fetchIgUserConnectedPage(igUserId, userAccessToken);
    if (!linked?.pageId) continue;

    const pageRow = pages.find((p) => p.id === linked.pageId);
    if (!pageRow?.access_token) continue;

    return {
      ...pageRow,
      instagram_business_account: {
        id: igUserId,
        username: linked.igUsername,
      },
    };
  }
  return null;
}

function buildOAuthNoIgError(
  pages: MetaPageRow[],
  businessOnlyPages: Array<{ id: string; name: string; igUsername: string | null }>,
): string {
  const names = pages.map((p) => `«${p.name}»`).join(', ') || '—';
  let msg =
    `Facebook повернув ${pages.length} сторінок (${names}), але на жодній Graph API не бачить підключений Instagram Business. `;

  if (businessOnlyPages.length > 0) {
    const bm = businessOnlyPages
      .map((p) => `«${p.name}»${p.igUsername ? ` (@${p.igUsername})` : ''}`)
      .join(', ');
    msg +=
      `У Business Manager знайдені інші сторінки з Instagram (${bm}), але до них немає доступу в цьому OAuth — ` +
      'увійдіть акаунтом-адміном цієї Page і в вікні Facebook натисніть «Змінити налаштування» / «Изменить настройки», щоб дозволити потрібну сторінку. ';
  } else {
    msg +=
      'Ймовірно, ви ввійшли не тим Facebook-профілем або не обрали потрібну Page у діалозі дозволів. ';
  }

  msg +=
    'Якщо в OAuth ви вже обрали і Page, і Instagram-акаунт, але помилка лишається — переконайтесь, що App у режимі Live з Advanced Access для instagram_manage_messages (для сторонніх бізнесів Development+Tester не достатньо). ';
  msg +=
    'Також перевірте в Business Suite: Instagram Professional привʼязаний до Facebook Page.';
  return msg;
}

// ── Multi-Page OAuth selection (tokens stay server-side) ─────────────────────

interface OAuthSelectionCandidate {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  igUserId: string;
  igUsername: string;
  hasInstagram: boolean;
}

interface PendingOAuthSelection {
  expiresAt: number;
  userAccessToken: string;
  candidates: OAuthSelectionCandidate[];
}

const pendingOAuthSelections = new Map<string, PendingOAuthSelection>();

function createOAuthSelectionSession(
  userAccessToken: string,
  candidates: OAuthSelectionCandidate[],
): string {
  const sessionId = crypto.randomBytes(16).toString('hex');
  pendingOAuthSelections.set(sessionId, {
    expiresAt: Date.now() + 10 * 60 * 1000,
    userAccessToken,
    candidates,
  });
  for (const [k, v] of pendingOAuthSelections) {
    if (v.expiresAt < Date.now()) pendingOAuthSelections.delete(k);
  }
  return sessionId;
}

function consumeOAuthSelectionSession(sessionId: string): PendingOAuthSelection | null {
  const entry = pendingOAuthSelections.get(sessionId);
  if (!entry || entry.expiresAt < Date.now()) {
    pendingOAuthSelections.delete(sessionId);
    return null;
  }
  pendingOAuthSelections.delete(sessionId);
  return entry;
}

function pageToCandidate(p: MetaPageRow): OAuthSelectionCandidate | null {
  if (!p.access_token) return null;
  return {
    pageId: p.id,
    pageName: p.name,
    pageAccessToken: p.access_token,
    igUserId: p.instagram_business_account?.id ?? '',
    igUsername: p.instagram_business_account?.username ?? '',
    hasInstagram: Boolean(p.instagram_business_account?.id),
  };
}

/**
 * Graph often omits instagram_business_account on /me/accounts for granular OAuth.
 * Re-probe with user token, Page token, /me, then pair IG target_ids to the selected Page.
 */
async function enrichOAuthCandidateInstagram(
  candidate: OAuthSelectionCandidate,
  userAccessToken: string,
  facebookAppId: string,
  facebookAppSecret: string,
): Promise<OAuthSelectionCandidate> {
  if (candidate.hasInstagram && candidate.igUserId) return candidate;

  let ig: IgBusinessAccount | undefined =
    (await probePageInstagram(candidate.pageId, userAccessToken)) ??
    (await probePageInstagram(candidate.pageId, candidate.pageAccessToken)) ??
    (await probeMeInstagram(candidate.pageAccessToken));

  if (!ig?.id) {
    const tokenDebug = await debugFacebookToken(
      userAccessToken,
      facebookAppId,
      facebookAppSecret,
    );
    let igIds = extractIgTargetIdsFromTokenDebug(tokenDebug);
    if (igIds.length === 0) {
      igIds = await listInstagramAccountIdsFromBusinesses(userAccessToken);
    }

    // Explicit Page↔IG link from Graph (when available).
    for (const igUserId of igIds) {
      const linked = await fetchIgUserConnectedPage(igUserId, userAccessToken);
      if (linked?.pageId && linked.pageId === candidate.pageId) {
        ig = { id: igUserId, username: linked.igUsername };
        break;
      }
    }

    // Granular OAuth often grants exactly one IG + several Pages while omitting
    // connected_facebook_page. If Graph does not say this IG belongs to another
    // Page, attach it to the Page the tenant just selected.
    if (!ig?.id && igIds.length === 1) {
      const igUserId = igIds[0];
      const linked = await fetchIgUserConnectedPage(igUserId, userAccessToken);
      const linkedToOtherPage =
        Boolean(linked?.pageId) && linked!.pageId !== candidate.pageId;
      if (!linkedToOtherPage) {
        const username =
          linked?.igUsername ??
          (await probeIgUsername(igUserId, candidate.pageAccessToken)) ??
          (await probeIgUsername(igUserId, userAccessToken));
        ig = { id: igUserId, username };
      }
    }
  }

  if (!ig?.id) return candidate;

  return {
    ...candidate,
    igUserId: ig.id,
    igUsername: ig.username ?? candidate.igUsername,
    hasInstagram: true,
  };
}

/** Re-probe partial candidates so the picker can show resolved IG when Meta allows it. */
async function enrichPartialCandidates(
  partial: OAuthSelectionCandidate[],
  userAccessToken: string,
  facebookAppId: string,
  facebookAppSecret: string,
): Promise<{ full: OAuthSelectionCandidate[]; partial: OAuthSelectionCandidate[] }> {
  const full: OAuthSelectionCandidate[] = [];
  const stillPartial: OAuthSelectionCandidate[] = [];
  for (const c of partial) {
    const enriched = await enrichOAuthCandidateInstagram(
      c,
      userAccessToken,
      facebookAppId,
      facebookAppSecret,
    );
    if (enriched.hasInstagram && enriched.igUserId) full.push(enriched);
    else stillPartial.push(enriched);
  }
  return { full, partial: stillPartial };
}

function collectPageCandidates(pages: MetaPageRow[]): {
  full: OAuthSelectionCandidate[];
  partial: OAuthSelectionCandidate[];
} {
  const full: OAuthSelectionCandidate[] = [];
  const partial: OAuthSelectionCandidate[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const c = pageToCandidate(p);
    if (!c || seen.has(c.pageId)) continue;
    seen.add(c.pageId);
    if (c.hasInstagram) full.push(c);
    else partial.push(c);
  }
  return { full, partial };
}

function mergeGranularPageIntoList(pages: MetaPageRow[], pageWithIg?: MetaPageRow): MetaPageRow[] {
  if (!pageWithIg?.access_token) return pages;
  const idx = pages.findIndex((p) => p.id === pageWithIg.id);
  if (idx < 0) return [...pages, pageWithIg];
  const merged = [...pages];
  merged[idx] = { ...merged[idx], ...pageWithIg };
  return merged;
}

function publicOAuthCandidates(candidates: OAuthSelectionCandidate[]) {
  return candidates.map(({ pageId, pageName, igUserId, igUsername, hasInstagram }) => ({
    pageId,
    pageName,
    igUserId,
    igUsername,
    hasInstagram,
  }));
}

function candidateToAvailablePage(c: OAuthSelectionCandidate): {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  igUserId: string;
  igUsername: string;
  hasInstagram: boolean;
  updatedAt: string;
} {
  return {
    pageId: c.pageId,
    pageName: c.pageName,
    pageAccessToken: c.pageAccessToken,
    igUserId: c.igUserId || '',
    igUsername: c.igUsername || '',
    hasInstagram: Boolean(c.hasInstagram && c.igUserId),
    updatedAt: new Date().toISOString(),
  };
}

function mergeAvailablePages(
  existing: unknown,
  incoming: Array<ReturnType<typeof candidateToAvailablePage>>,
): Array<ReturnType<typeof candidateToAvailablePage>> {
  const byId = new Map<string, ReturnType<typeof candidateToAvailablePage>>();
  if (Array.isArray(existing)) {
    for (const raw of existing) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const pageId = String(p.pageId ?? '');
      const token = String(p.pageAccessToken ?? '');
      if (!pageId || !token) continue;
      byId.set(pageId, {
        pageId,
        pageName: String(p.pageName ?? pageId),
        pageAccessToken: token,
        igUserId: String(p.igUserId ?? ''),
        igUsername: String(p.igUsername ?? ''),
        hasInstagram: Boolean(p.hasInstagram || p.igUserId),
        updatedAt: String(p.updatedAt ?? ''),
      });
    }
  }
  for (const page of incoming) {
    if (!page.pageId || !page.pageAccessToken) continue;
    const prev = byId.get(page.pageId);
    byId.set(page.pageId, {
      ...page,
      igUserId: page.igUserId || prev?.igUserId || '',
      igUsername: page.igUsername || prev?.igUsername || '',
      hasInstagram: Boolean(page.igUserId || prev?.igUserId),
    });
  }
  return [...byId.values()].sort((a, b) => a.pageName.localeCompare(b.pageName, 'uk'));
}

async function persistMetaOAuthConnection(
  app: FastifyInstance,
  input: {
    pageId: string;
    pageName: string;
    pageAccessToken: string;
    userAccessToken: string;
    igUserId: string;
    igUsername: string;
    /** All Pages from this OAuth run (tokens stay server-side for later switching). */
    availablePages?: OAuthSelectionCandidate[];
  },
): Promise<void> {
  const { meta } = await getIntegrationConfig();

  try {
    const sub = await subscribePageToMetaWebhooks(input.pageId, input.pageAccessToken);
    if (!sub.ok) {
      app.log.warn(
        { status: sub.status, body: sub.body, pageId: input.pageId },
        'Page webhook subscription failed (non-fatal)',
      );
    } else {
      app.log.info({ pageId: input.pageId }, 'Page webhook subscribed successfully');
    }
  } catch (subErr) {
    app.log.warn({ err: subErr, pageId: input.pageId }, 'Page webhook subscription error (non-fatal)');
  }

  const existing = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
  const existingData = (existing?.value ?? {}) as Record<string, unknown>;
  const previousPageId = String(existingData.pageId ?? '');
  const pageChanged = Boolean(previousPageId) && previousPageId !== input.pageId;

  const catalogIncoming = [
    ...(input.availablePages ?? []),
    {
      pageId: input.pageId,
      pageName: input.pageName,
      pageAccessToken: input.pageAccessToken,
      igUserId: input.igUserId,
      igUsername: input.igUsername,
      hasInstagram: Boolean(input.igUserId),
    } satisfies OAuthSelectionCandidate,
  ];

  const merged: Record<string, unknown> = {
    ...existingData,
    pageId: input.pageId,
    pageAccessToken: input.pageAccessToken,
    userAccessToken: input.userAccessToken,
    availablePages: mergeAvailablePages(
      existingData.availablePages,
      catalogIncoming.map(candidateToAvailablePage),
    ),
  };

  // Never blank out a known IG on same-page re-auth. Switching Page without a
  // resolved IG clears stale ids so routing does not point at the previous asset.
  if (input.igUserId) {
    merged.igUserId = input.igUserId;
    merged.igUsername = input.igUsername || '';
  } else if (pageChanged) {
    merged.igUserId = '';
    merged.igUsername = '';
  }

  await prisma.setting.upsert({
    where: { key: 'integration_meta' },
    create: { key: 'integration_meta', value: merged as never },
    update: { value: merged as never },
  });

  invalidateIntegrationConfigCache();

  const savedIgUserId = String(merged.igUserId ?? '');
  const savedIgUsername = String(merged.igUsername ?? '');

  app.log.info(
    {
      pageId: input.pageId,
      pageName: input.pageName,
      igUserId: savedIgUserId || null,
      igUsername: savedIgUsername || null,
      preservedExistingIg: !input.igUserId && !pageChanged && Boolean(savedIgUserId),
      availablePages: Array.isArray(merged.availablePages)
        ? (merged.availablePages as unknown[]).length
        : 0,
    },
    'Facebook OAuth credentials saved',
  );

  if (savedIgUserId && meta.facebookAppSecret) {
    await clearWebhookRoutingOnHub(app.log);
    syncWebhookRoutingToHub(
      savedIgUserId,
      meta.facebookAppSecret,
      app.log,
      input.pageAccessToken,
      input.pageId,
    );
  }
}

function buildPopupHtml(message: Record<string, unknown>): string {
  const json = JSON.stringify(message);
  return `<!DOCTYPE html>
<html lang="uk">
<head><meta charset="utf-8"><title>Facebook OAuth</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;color:#555">
<p>Обробляємо авторизацію...</p>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage(${json}, '*');
    }
  } catch (e) {}
  setTimeout(function() { window.close(); }, 400);
<\/script>
</body>
</html>`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function metaOAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /settings/meta/oauth-init
   * Authenticated. Returns the Facebook Login authorization URL.
   * App ID must already be saved in DB (appSecret is read in the callback).
   */
  app.get('/meta/oauth-init', { onRequest: [app.authenticate, app.requireOwner] }, async (_request, reply) => {
    const { meta } = await getIntegrationConfig();

    if (!meta.facebookAppId) {
      return reply.code(400).send({ error: 'Facebook App ID не налаштовано' });
    }

    let redirectUri: string;
    let state: string;
    try {
      redirectUri = resolveOAuthRedirectUri();
      state = generateState(redirectUri);
    } catch (err: any) {
      return reply.code(400).send({
        error: err?.message ?? 'OAuth hub не налаштовано (перевірте SUPERVISOR_SHARED_SECRET)',
      });
    }

    const url = new URL(FB_AUTHORIZE_URL);
    url.searchParams.set('client_id', meta.facebookAppId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', FB_SCOPES);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return { authUrl: url.toString() };
  });

  /**
   * GET /settings/meta/oauth-callback
   * Public — Facebook redirects here after the user authorizes.
   *   code → User Access Token → Page list → Page Access Token
   *   → subscribe webhook → save pageId + pageAccessToken + igUserId to DB
   * Sends result to opener via postMessage and closes the popup.
   */
  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      error_reason?: string;
    };
  }>('/meta/oauth-callback', async (request, reply) => {
    const { code, state, error: fbError, error_description, error_reason } = request.query;

    reply.type('text/html');

    if (fbError) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: error_description ?? error_reason ?? fbError,
        }),
      );
    }

    if (!code || !state) {
      return reply.send(
        buildPopupHtml({ type: 'meta_oauth_error', error: 'Missing code or state parameter' }),
      );
    }

    if (!consumeState(state)) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: 'Invalid or expired state - please try again',
        }),
      );
    }

    const { meta } = await getIntegrationConfig();
    if (!meta.facebookAppId || !meta.facebookAppSecret) {
      return reply.send(
        buildPopupHtml({
          type: 'meta_oauth_error',
          error: 'Facebook App ID / Secret не налаштовано - збережіть їх перед авторизацією',
        }),
      );
    }

    const redirectUri = resolveOAuthRedirectUri();

    try {
      // Step 1 — exchange code for User Access Token
      const tokenUrl = new URL(FB_TOKEN_URL);
      tokenUrl.searchParams.set('client_id', meta.facebookAppId);
      tokenUrl.searchParams.set('client_secret', meta.facebookAppSecret);
      tokenUrl.searchParams.set('redirect_uri', redirectUri);
      tokenUrl.searchParams.set('code', code);

      const tokenRes = await fetch(tokenUrl.toString(), {
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: { message?: string };
      };

      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(
          tokenData.error?.message ?? `Token exchange failed: ${tokenRes.status}`,
        );
      }

      const userAccessToken = tokenData.access_token;
      app.log.info(
        {
          expiresIn: tokenData.expires_in ?? null,
          tokenType: tokenData.token_type ?? null,
        },
        'Facebook OAuth: user access token obtained',
      );

      // Step 2 — get Pages the user manages, with their Instagram Business Accounts.
      // We need both the Page Access Token and the connected IG account ID.
      const pagesUrl = new URL(`${FB_GRAPH_BASE}/me/accounts`);
      pagesUrl.searchParams.set('fields', PAGE_LIST_FIELDS);

      const pagesRes = await fetch(pagesUrl.toString(), {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const pagesData = (await pagesRes.json()) as {
        data?: MetaPageRow[];
        paging?: { next?: string };
        error?: { message?: string; type?: string; code?: number };
      };

      if (!pagesRes.ok || !pagesData.data) {
        app.log.warn(
          {
            httpStatus: pagesRes.status,
            graphError: pagesData.error?.message,
            graphErrorType: pagesData.error?.type,
            graphErrorCode: pagesData.error?.code,
          },
          'Facebook OAuth: /me/accounts request failed',
        );
        throw new Error(
          pagesData.error?.message ?? `Failed to fetch pages: ${pagesRes.status}`,
        );
      }

      const pagesSummary = summarizePagesList(pagesData.data);
      app.log.debug(
        {
          pageCount: pagesData.data.length,
          pagesWithInstagram: pagesSummary.filter((p) => p.hasInstagram).length,
          pages: pagesSummary,
          hasPagingNext: Boolean(pagesData.paging?.next),
        },
        'Facebook OAuth: /me/accounts response',
      );

      const { pages: resolvedPages, businessOnlyPages } = await resolvePagesWithInstagram(
        pagesData.data,
        userAccessToken,
      );
      const resolvedSummary = summarizePagesList(resolvedPages);
      if (resolvedSummary.some((p) => p.hasInstagram) && !pagesSummary.some((p) => p.hasInstagram)) {
        app.log.info(
          { pages: resolvedSummary.filter((p) => p.hasInstagram) },
          'Facebook OAuth: instagram_business_account resolved via per-page / Business Portfolio probe',
        );
      }
      if (businessOnlyPages.length > 0) {
        app.log.warn(
          { businessOnlyPages },
          'Facebook OAuth: IG-linked pages visible in Business Manager but not granted in /me/accounts',
        );
      }

      let pageWithIg = resolvedPages.find(
        (p) => p.instagram_business_account?.id && p.access_token,
      );

      const tokenDebug =
        pageWithIg
          ? null
          : await debugFacebookToken(
              userAccessToken,
              meta.facebookAppId,
              meta.facebookAppSecret,
            );

      if (!pageWithIg && tokenDebug) {
        const igTargetIds = extractIgTargetIdsFromTokenDebug(tokenDebug);

        pageWithIg =
          (await resolvePageFromSelectedInstagramAccounts(
            userAccessToken,
            resolvedPages,
            tokenDebug,
          )) ?? undefined;

        if (pageWithIg) {
          app.log.info(
            {
              pageId: pageWithIg.id,
              pageName: pageWithIg.name,
              igUserId: pageWithIg.instagram_business_account?.id,
              igUsername: pageWithIg.instagram_business_account?.username,
              igTargetIds,
              via: 'granular_oauth_target_ids',
            },
            'Facebook OAuth: resolved Page+IG via selected Instagram account',
          );
        } else {
          const granularResolveAttempts: Array<Record<string, unknown>> = [];
          for (const igId of igTargetIds.length > 0
            ? igTargetIds
            : await listInstagramAccountIdsFromBusinesses(userAccessToken)) {
            const probe = await fetchIgUserConnectedPage(igId, userAccessToken);
            if (probe) granularResolveAttempts.push(probe);
          }
          app.log.warn(
            {
              pageCount: resolvedPages.length,
              pagesWithInstagram: resolvedSummary.filter((p) => p.hasInstagram).length,
              pages: resolvedSummary,
              businessOnlyPages,
              hasPagingNext: Boolean(pagesData.paging?.next),
              requestedScopes: FB_SCOPES,
              tokenDebug,
              igTargetIds,
              granularResolveAttempts,
            },
            'Facebook OAuth: no Page with linked Instagram Business account',
          );
        }
      }

      const pagesForSelection = mergeGranularPageIntoList(resolvedPages, pageWithIg);
      let { full: fullCandidates, partial: partialCandidates } =
        collectPageCandidates(pagesForSelection);

      // Partial Pages often still resolve once we re-probe / pair granular IG ids.
      // Do this before the picker so the UI can show @username when available.
      if (partialCandidates.length > 0) {
        const enrichedPartials = await enrichPartialCandidates(
          partialCandidates,
          userAccessToken,
          meta.facebookAppId,
          meta.facebookAppSecret,
        );
        if (enrichedPartials.full.length > 0) {
          app.log.info(
            {
              resolvedCount: enrichedPartials.full.length,
              stillPartial: enrichedPartials.partial.length,
              pages: publicOAuthCandidates(enrichedPartials.full),
            },
            'Facebook OAuth: Instagram resolved for previously partial Pages',
          );
        }
        fullCandidates = [...fullCandidates, ...enrichedPartials.full];
        partialCandidates = enrichedPartials.partial;
      }

      app.log.info(
        {
          fullCount: fullCandidates.length,
          partialCount: partialCandidates.length,
          pages: publicOAuthCandidates([...fullCandidates, ...partialCandidates]),
        },
        'Facebook OAuth: page candidates collected',
      );

      const oauthCatalog = () => [...fullCandidates, ...partialCandidates];

      const finalizeCandidate = async (c: OAuthSelectionCandidate) => {
        const enriched = await enrichOAuthCandidateInstagram(
          c,
          userAccessToken,
          meta.facebookAppId,
          meta.facebookAppSecret,
        );
        const availablePages = oauthCatalog().map((row) =>
          row.pageId === enriched.pageId ? enriched : row,
        );
        if (!availablePages.some((row) => row.pageId === enriched.pageId)) {
          availablePages.push(enriched);
        }
        await persistMetaOAuthConnection(app, {
          pageId: enriched.pageId,
          pageName: enriched.pageName,
          pageAccessToken: enriched.pageAccessToken,
          userAccessToken,
          igUserId: enriched.igUserId,
          igUsername: enriched.igUsername,
          availablePages,
        });
        return {
          pageId: enriched.pageId,
          pageName: enriched.pageName,
          igUserId: enriched.igUserId,
          igUsername: enriched.igUsername,
        };
      };

      if (fullCandidates.length === 1) {
        const account = await finalizeCandidate(fullCandidates[0]);
        return reply.send(
          buildPopupHtml({
            type: 'meta_oauth_success',
            account,
          }),
        );
      }

      if (fullCandidates.length > 1) {
        const sessionId = createOAuthSelectionSession(userAccessToken, fullCandidates);
        return reply.send(
          buildPopupHtml({
            type: 'meta_oauth_select',
            sessionId,
            candidates: publicOAuthCandidates(fullCandidates),
            needsManualIg: false,
            message:
              'Знайдено кілька Facebook Page з Instagram. Оберіть одну сторінку в адмінці.',
          }),
        );
      }

      if (partialCandidates.length === 1) {
        const account = await finalizeCandidate(partialCandidates[0]);
        if (account.igUserId) {
          return reply.send(
            buildPopupHtml({
              type: 'meta_oauth_success',
              account,
            }),
          );
        }
        return reply.send(
          buildPopupHtml({
            type: 'meta_oauth_partial',
            account,
            message:
              'Facebook Page і Page Access Token збережено. Instagram Business ID Graph API не повернув — введіть Instagram User ID та @username вручну в Settings і натисніть «Зберегти Instagram».',
          }),
        );
      }

      if (partialCandidates.length > 1) {
        const sessionId = createOAuthSelectionSession(userAccessToken, partialCandidates);
        return reply.send(
          buildPopupHtml({
            type: 'meta_oauth_select',
            sessionId,
            candidates: publicOAuthCandidates(partialCandidates),
            needsManualIg: true,
            message:
              'Знайдено кілька Facebook Page. Оберіть потрібну — після вибору підставимо Instagram автоматично, якщо Meta віддасть звʼязок. Лише якщо ні, доповните ID вручну.',
          }),
        );
      }

      throw new Error(buildOAuthNoIgError(resolvedPages, businessOnlyPages));
    } catch (err: any) {
      app.log.error({ err }, 'Facebook OAuth callback error');
      return reply.send(
        buildPopupHtml({ type: 'meta_oauth_error', error: err.message ?? 'OAuth failed' }),
      );
    }
  });

  /**
   * POST /settings/meta/oauth-select
   * Authenticated. Finalizes OAuth when the user picked one Page from multiple candidates.
   * Page access tokens never leave the server — only a short-lived sessionId is sent to the UI.
   */
  app.post<{
    Body: { sessionId?: string; pageId?: string };
  }>('/meta/oauth-select', { onRequest: [app.authenticate, app.requireOwner] }, async (request, reply) => {
    const { sessionId, pageId } = request.body ?? {};

    if (!sessionId || !pageId) {
      return reply.code(400).send({ error: 'sessionId та pageId обовʼязкові' });
    }

    const session = consumeOAuthSelectionSession(sessionId);
    if (!session) {
      return reply.code(400).send({
        error: 'Сесія вибору застаріла або вже використана — повторіть авторизацію Facebook',
      });
    }

    const candidate = session.candidates.find((c) => c.pageId === pageId);
    if (!candidate) {
      return reply.code(400).send({ error: 'Обрану сторінку не знайдено в сесії OAuth' });
    }

    const { meta } = await getIntegrationConfig();
    const enriched = await enrichOAuthCandidateInstagram(
      candidate,
      session.userAccessToken,
      meta.facebookAppId,
      meta.facebookAppSecret,
    );

    const availablePages = session.candidates.map((row) =>
      row.pageId === enriched.pageId ? enriched : row,
    );

    await persistMetaOAuthConnection(app, {
      pageId: enriched.pageId,
      pageName: enriched.pageName,
      pageAccessToken: enriched.pageAccessToken,
      userAccessToken: session.userAccessToken,
      igUserId: enriched.igUserId,
      igUsername: enriched.igUsername,
      availablePages,
    });

    app.log.info(
      {
        pageId: enriched.pageId,
        igUserId: enriched.igUserId || null,
        igUsername: enriched.igUsername || null,
        resolvedInstagram: Boolean(enriched.igUserId),
        catalogSize: availablePages.length,
      },
      'Facebook OAuth: page selection finalized',
    );

    // Re-read after persist — may have preserved IG on same-page re-auth.
    const { meta: savedMeta } = await getIntegrationConfig();
    const resolvedIgUserId = enriched.igUserId || savedMeta.igUserId || '';
    const resolvedIgUsername = enriched.igUsername || savedMeta.igUsername || '';
    const accountResolved = {
      pageId: enriched.pageId,
      pageName: enriched.pageName,
      igUserId: resolvedIgUserId,
      igUsername: resolvedIgUsername,
    };

    return {
      account: accountResolved,
      partial: !resolvedIgUserId,
      message: resolvedIgUserId
        ? `Підключено @${resolvedIgUsername || resolvedIgUserId} (Page: ${enriched.pageName})`
        : 'Page і токен збережено. Instagram ID Meta не віддала для цієї Page — вкажіть його вручну нижче і натисніть «Зберегти Instagram».',
    };
  });

  /**
   * POST /settings/meta/activate-page
   * Switch the active Facebook Page among those saved from the last OAuth catalog.
   * Does not require a new Facebook login when the Page token is still stored.
   */
  app.post<{
    Body: { pageId?: string };
  }>('/meta/activate-page', { onRequest: [app.authenticate, app.requireOwner] }, async (request, reply) => {
    const pageId = String(request.body?.pageId ?? '').trim();
    if (!pageId) {
      return reply.code(400).send({ error: 'pageId обовʼязковий' });
    }

    const existing = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
    const existingData = (existing?.value ?? {}) as Record<string, unknown>;
    const catalog = Array.isArray(existingData.availablePages)
      ? (existingData.availablePages as Array<Record<string, unknown>>)
      : [];
    const page = catalog.find((p) => String(p.pageId ?? '') === pageId);
    if (!page) {
      return reply.code(404).send({
        error:
          'Цю Page не знайдено в збереженому списку. Повторіть «Авторизуватись через Facebook», щоб оновити каталог.',
      });
    }

    const pageAccessToken = String(page.pageAccessToken ?? '');
    if (!pageAccessToken) {
      return reply.code(400).send({
        error: 'Для цієї Page немає збереженого токена — повторіть авторизацію Facebook',
      });
    }

    let igUserId = String(page.igUserId ?? '');
    let igUsername = String(page.igUsername ?? '');
    const pageName = String(page.pageName ?? pageId);
    const { meta } = await getIntegrationConfig();
    const userAccessToken = String(existingData.userAccessToken ?? '');

    if (!igUserId && userAccessToken && meta.facebookAppId && meta.facebookAppSecret) {
      const enriched = await enrichOAuthCandidateInstagram(
        {
          pageId,
          pageName,
          pageAccessToken,
          igUserId: '',
          igUsername: '',
          hasInstagram: false,
        },
        userAccessToken,
        meta.facebookAppId,
        meta.facebookAppSecret,
      );
      igUserId = enriched.igUserId;
      igUsername = enriched.igUsername;
    }

    await persistMetaOAuthConnection(app, {
      pageId,
      pageName,
      pageAccessToken,
      userAccessToken,
      igUserId,
      igUsername,
      availablePages: catalog.map((raw) => {
        const id = String(raw.pageId ?? '');
        if (id === pageId) {
          return {
            pageId,
            pageName,
            pageAccessToken,
            igUserId,
            igUsername,
            hasInstagram: Boolean(igUserId),
          };
        }
        return {
          pageId: id,
          pageName: String(raw.pageName ?? id),
          pageAccessToken: String(raw.pageAccessToken ?? ''),
          igUserId: String(raw.igUserId ?? ''),
          igUsername: String(raw.igUsername ?? ''),
          hasInstagram: Boolean(raw.hasInstagram || raw.igUserId),
        };
      }),
    });

    const { meta: saved } = await getIntegrationConfig();

    return {
      account: {
        pageId: saved.pageId,
        pageName,
        igUserId: saved.igUserId,
        igUsername: saved.igUsername,
      },
      partial: !saved.igUserId,
      message: saved.igUserId
        ? `Активна Page: ${pageName} (@${saved.igUsername || saved.igUserId})`
        : `Активна Page: ${pageName}. Instagram ID не відомий — доповніть вручну.`,
    };
  });

  /**
   * GET /settings/meta/status
   * Verifies the saved Page Access Token is still valid and returns
   * the connected Instagram Business account info.
   */
  app.get('/meta/status', { onRequest: [app.authenticate, app.requireOwner] }, async () => {
    return checkIgConnectionStatus();
  });

  /**
   * POST /settings/meta/webhook-subscribe
   * Explicit POST /{page-id}/subscribed_apps so admin can see success/failure
   * without reading API logs. GET 403 without pages_manage_metadata is expected.
   */
  app.post('/meta/webhook-subscribe', { onRequest: [app.authenticate, app.requireOwner] }, async (_request, reply) => {
    const { meta } = await getIntegrationConfig();
    if (!meta.pageId || !meta.pageAccessToken) {
      return reply.code(400).send({
        error: 'Page не підключено — спочатку авторизуйтесь через Facebook',
      });
    }

    const result = await runPageWebhookSubscribe(meta.pageId, meta.pageAccessToken);
    app.log.info(
      {
        pageId: result.pageId,
        subscribeOk: result.subscribeOk,
        postStatus: result.post.status,
        readStatus: result.read?.status ?? null,
      },
      result.subscribeOk
        ? 'Page webhook subscribed successfully'
        : 'Page webhook subscription failed (admin check)',
    );
    return result;
  });

  /**
   * GET /settings/meta/debug
   * Diagnostic: hits several Facebook/Instagram Graph API endpoints with the
   * stored Page token and returns raw responses.
   */
  app.get('/meta/debug', { onRequest: [app.authenticate, app.requireOwner] }, async () => {
    const { meta } = await getIntegrationConfig();
    if (!meta.pageAccessToken) {
      return { error: 'Facebook авторизацію не виконано — натисніть «Авторизуватись через Facebook»' };
    }

    const token = meta.pageAccessToken;
    const pageId = meta.pageId;
    const igUserId = meta.igUserId;

    const probe = async (
      label: string,
      url: string,
      opts: { auth?: 'query' | 'bearer' } = {},
    ) => {
      const auth = opts.auth ?? 'bearer';
      const finalUrl = new URL(url);
      if (auth === 'query') {
        finalUrl.searchParams.set('access_token', token);
      }
      const headers: Record<string, string> = {};
      if (auth === 'bearer') {
        headers.Authorization = `Bearer ${token}`;
      }
      try {
        const res = await fetch(finalUrl.toString(), {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const hdrs: Record<string, string> = {};
        for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-fb-trace-id', 'x-fb-rev']) {
          const v = res.headers.get(h);
          if (v) hdrs[h] = v;
        }
        return {
          label,
          auth,
          url: finalUrl.toString().replace(token, '«TOKEN»'),
          status: res.status,
          headers: hdrs,
          body: parsed ?? text.slice(0, 2000),
        };
      } catch (e: any) {
        return {
          label,
          auth,
          url: finalUrl.toString().replace(token, '«TOKEN»'),
          error: e.message ?? String(e),
        };
      }
    };

    const commentsProbePromise = igUserId
      ? probeInstagramManageComments(igUserId, token).then((r) => ({
          label: 'instagram_manage_comments (GET /{media}/comments)',
          status: r.commentsStatus ?? r.mediaListStatus ?? (r.ok ? 200 : 0),
          body: r,
        }))
      : Promise.resolve({
          label: 'instagram_manage_comments',
          error: 'igUserId not set',
        });

    const probes = await Promise.all([
      // Page token /me — often returns Page node without nested IG (granular OAuth).
      probe(
        '/me?fields=id,name,instagram_business_account (Bearer)',
        `${FB_GRAPH_BASE}/me?fields=id,name,instagram_business_account{id,username,name,ig_id}`,
      ),
      // Prefer Page node for IG linkage + ig_id (webhook recipient.id).
      pageId
        ? probe(
            `/${pageId}?fields=instagram_business_account (Bearer)`,
            `${FB_GRAPH_BASE}/${pageId}?fields=instagram_business_account{id,username,name,ig_id}`,
          )
        : Promise.resolve({ label: 'page_instagram', error: 'pageId not set' }),
      // Conversations — best proof that IG DM API works for this Page token.
      pageId
        ? probe(
            `/${pageId}/conversations?platform=instagram (Bearer)`,
            `${FB_GRAPH_BASE}/${pageId}/conversations?platform=instagram&limit=3&fields=id,updated_time,participants`,
          )
        : Promise.resolve({ label: 'conversations', error: 'pageId not set' }),
      // App Review: instagram_manage_comments — GET /{ig-media-id}/comments.
      commentsProbePromise,
      // Read webhook subscription — often 403 without pages_manage_metadata (expected).
      pageId
        ? probe(
            `/${pageId}/subscribed_apps (Bearer)`,
            `${FB_GRAPH_BASE}/${pageId}/subscribed_apps`,
          )
        : Promise.resolve({ label: 'subscribed_apps', error: 'pageId not set' }),
      // Direct IG node — frequently 400 with Page token; non-blocking if conversations OK.
      igUserId
        ? probe(
            `/${igUserId}?fields=id,username,name (Bearer)`,
            `${FB_GRAPH_BASE}/${igUserId}?fields=id,username,name`,
          )
        : Promise.resolve({ label: 'ig_account_direct', error: 'igUserId not set' }),
    ]);

    // debug_token — shows actual scopes on the page token
    let tokenDebug: unknown = null;
    if (meta.facebookAppId && meta.facebookAppSecret) {
      try {
        const appToken = `${meta.facebookAppId}|${meta.facebookAppSecret}`;
        const debugUrl = new URL('https://graph.facebook.com/v25.0/debug_token');
        debugUrl.searchParams.set('input_token', token);
        debugUrl.searchParams.set('access_token', appToken);
        const dtRes = await fetch(debugUrl.toString(), { signal: AbortSignal.timeout(8_000) });
        const dtText = await dtRes.text();
        try {
          tokenDebug = JSON.parse(dtText);
        } catch {
          tokenDebug = dtText.slice(0, 2000);
        }
      } catch (e: any) {
        tokenDebug = { error: e.message ?? String(e) };
      }
    }

    type ProbeRow = { label?: string; status?: number; body?: unknown; error?: string };
    const rows = probes as ProbeRow[];
    const convOk = rows.some((p) => p.label?.includes('conversations') && p.status === 200);
    const pageIgBody = rows.find((p) => p.label?.includes('page_instagram'))?.body as
      | { instagram_business_account?: { id?: string; ig_id?: string | number; username?: string } }
      | undefined;
    const pageIg = pageIgBody?.instagram_business_account;
    const subProbe = rows.find((p) => p.label?.includes('subscribed_apps'));
    const sub403 =
      subProbe?.status === 403 &&
      JSON.stringify(subProbe.body ?? '').includes('pages_manage_metadata');

    const notes: string[] = [];
    if (convOk) {
      notes.push(
        'IG DM API працює (conversations 200) — зовнішні клієнти можуть писати в DM без реєстрації в нашій БД.',
      );
    }
    if (pageIg?.id) {
      notes.push(
        `Instagram з Page node: id=${pageIg.id}` +
          (pageIg.ig_id != null ? `, ig_id=${pageIg.ig_id} (часто recipient.id у webhook)` : '') +
          (pageIg.username ? `, @${pageIg.username}` : ''),
      );
    } else if (igUserId && convOk) {
      notes.push(
        'Graph не повернув instagram_business_account на Page — використовуйте збережений IG User ID; перевірте hub routing (ig_id).',
      );
    }
    if (sub403) {
      notes.push(
        'subscribed_apps 403 — очікувано без pages_manage_metadata; підписка webhook при OAuth може працювати, але перевірка статусу в UI обмежена.',
      );
    }
    const igDirect = rows.find((p) => p.label === 'ig_account_direct');
    if (igDirect?.status === 400 && convOk) {
      notes.push(
        'Прямий GET /{ig-user-id} 400 з Page token — не критично; орієнтуйтесь на conversations і Page node.',
      );
    }
    const commentsRow = rows.find((p) => p.label?.includes('instagram_manage_comments'));
    const commentsBody = commentsRow?.body as { ok?: boolean; noteUk?: string } | undefined;
    if (commentsBody?.ok) {
      notes.push(
        commentsBody.noteUk ??
          'instagram_manage_comments: GET /{media}/comments → 200 (для Meta App Review).',
      );
    } else if (commentsBody?.noteUk) {
      notes.push(commentsBody.noteUk);
    }

    return {
      pageId,
      igUserId,
      igUsername: meta.igUsername,
      apiVersion: 'v25.0 (graph.facebook.com)',
      summary: { okForDm: convOk, notes },
      tokenDebug,
      probes,
    };
  });

  /**
   * POST /settings/meta/disconnect
   * Unlinks the connected Facebook Page / Instagram account:
   *   1. best-effort unsubscribe the Page from webhook events
   *   2. clear connection fields in integration_meta (pageId, tokens, IG ids)
   *   3. best-effort clear instagramUserId routing on the platform hub
   * Conversations and other settings are left intact.
   */
  app.post('/meta/disconnect', { onRequest: [app.authenticate, app.requireOwner] }, async (_request, reply) => {
    const { meta } = await getIntegrationConfig();

    if (!meta.pageId && !meta.pageAccessToken && !meta.igUserId) {
      return reply.code(400).send({ error: 'Instagram не підключено — нічого відвʼязувати' });
    }

    // Step 1 — unsubscribe Page from webhook events (non-fatal).
    if (meta.pageId && meta.pageAccessToken) {
      try {
        const unsubRes = await fetch(`${FB_GRAPH_BASE}/${meta.pageId}/subscribed_apps`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${meta.pageAccessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!unsubRes.ok) {
          const body = await unsubRes.text().catch(() => '');
          app.log.warn(
            { status: unsubRes.status, body: body.slice(0, 300) },
            'Page webhook unsubscribe failed (non-fatal)',
          );
        } else {
          app.log.info({ pageId: meta.pageId }, 'Page webhook unsubscribed');
        }
      } catch (unsubErr) {
        app.log.warn({ err: unsubErr }, 'Page webhook unsubscribe error (non-fatal)');
      }
    }

    // Step 2 — clear connection fields in integration_meta, preserving the rest.
    const existing = await prisma.setting.findUnique({ where: { key: 'integration_meta' } });
    const existingData = (existing?.value ?? {}) as Record<string, unknown>;

    const merged = {
      ...existingData,
      pageId: '',
      pageAccessToken: '',
      userAccessToken: '',
      igUserId: '',
      igUsername: '',
      availablePages: [],
    };

    await prisma.setting.upsert({
      where: { key: 'integration_meta' },
      create: { key: 'integration_meta', value: merged },
      update: { value: merged },
    });

    invalidateIntegrationConfigCache();

    app.log.info(
      { pageId: meta.pageId, igUserId: meta.igUserId, igUsername: meta.igUsername },
      'Instagram connection removed',
    );

    // Step 3 — clear webhook routing on the platform hub (non-fatal) so the
    // IG account can be re-connected by this or another tenant later.
    await clearWebhookRoutingOnHub(app.log);

    return { ok: true };
  });

  /**
   * POST /settings/meta/import-recent-conversations
   * Bulk-imports the last N Instagram conversations (default 20) into our DB.
   */
  app.post<{ Body: { limit?: number } }>(
    '/meta/import-recent-conversations',
    { onRequest: [app.authenticate, app.requireOwner] },
    async (request, reply) => {
      const limit = Math.max(1, Math.min(500, Number(request.body?.limit) || 20));

      try {
        const result = await importRecentIgConversations(limit);
        return result;
      } catch (err: any) {
        app.log.error({ err }, 'Failed to import recent IG conversations');
        return reply
          .code(500)
          .send({ error: err.message ?? 'Не вдалося завантажити розмови' });
      }
    },
  );
}
