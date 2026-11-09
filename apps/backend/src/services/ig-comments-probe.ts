/**
 * Probe that exercises `instagram_manage_comments` for Meta App Review.
 *
 * Canonical Facebook Login path (graph.facebook.com + Page token):
 *   1. GET /{ig-user-id}/media?limit=1
 *   2. GET /{ig-media-id}/comments
 *
 * A HTTP 200 on the comments edge is what Meta's "Testing your use cases"
 * counter usually needs (can take up to ~24h to show).
 */

import pino from 'pino';

const log = pino({ name: 'ig-comments-probe' });

const FB_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

export type IgCommentsProbeResult = {
  /** True when GET /{media-id}/comments returned 200. */
  ok: boolean;
  mediaListStatus?: number;
  commentsStatus?: number;
  mediaId?: string;
  commentsReturned?: number;
  /** Short Ukrainian note for admin UI. */
  noteUk: string;
  errorBody?: string;
};

async function graphGetJson(
  pathAndQuery: string,
  pageAccessToken: string,
): Promise<{ status: number; json: unknown; raw: string }> {
  const url = new URL(`${FB_GRAPH_BASE}/${pathAndQuery.replace(/^\//, '')}`);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${pageAccessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, raw: raw.slice(0, 800) };
}

/**
 * Hit IG media + comments edges so App Review can count `instagram_manage_comments`.
 * Non-fatal for product connection — always returns a structured result.
 */
export async function probeInstagramManageComments(
  igUserId: string,
  pageAccessToken: string,
): Promise<IgCommentsProbeResult> {
  const igId = igUserId.trim();
  if (!igId || !pageAccessToken.trim()) {
    return {
      ok: false,
      noteUk: 'Немає Instagram User ID або Page token для тесту comments.',
    };
  }

  try {
    const media = await graphGetJson(
      `${encodeURIComponent(igId)}/media?fields=id,caption,comments_count&limit=1`,
      pageAccessToken,
    );

    if (media.status !== 200) {
      log.warn(
        { igUserId: igId, status: media.status, body: media.raw },
        'IG media list failed during comments probe',
      );
      return {
        ok: false,
        mediaListStatus: media.status,
        errorBody: media.raw,
        noteUk:
          media.status === 400 || media.status === 403
            ? 'Не вдалося прочитати media для тесту comments — повторіть «Авторизуватись через Facebook» (потрібен scope instagram_manage_comments) або переконайтесь, що на акаунті є хоча б один пост.'
            : `Список media повернув HTTP ${media.status} — comments-тест не виконано.`,
      };
    }

    const mediaData = media.json as { data?: Array<{ id?: string }> } | null;
    const mediaId = mediaData?.data?.[0]?.id?.trim();
    if (!mediaId) {
      return {
        ok: false,
        mediaListStatus: 200,
        noteUk:
          'На Instagram немає постів у вибірці media — опублікуйте 1 пост і знову натисніть «Перевірити підключення» / «Діагностика API», щоб Meta зарахувала instagram_manage_comments.',
      };
    }

    const comments = await graphGetJson(
      `${encodeURIComponent(mediaId)}/comments?fields=id,text,timestamp&limit=5`,
      pageAccessToken,
    );

    if (comments.status === 200) {
      const commentsData = comments.json as { data?: unknown[] } | null;
      const n = commentsData?.data?.length ?? 0;
      log.info(
        { igUserId: igId, mediaId, commentsReturned: n },
        'instagram_manage_comments probe ok',
      );
      return {
        ok: true,
        mediaListStatus: 200,
        commentsStatus: 200,
        mediaId,
        commentsReturned: n,
        noteUk:
          `Тест instagram_manage_comments OK (GET /{media}/comments → 200, коментарів у вибірці: ${n}). У Meta App Review лічильник може оновитись протягом ~24 год.`,
      };
    }

    log.warn(
      { igUserId: igId, mediaId, status: comments.status, body: comments.raw },
      'IG comments edge failed during probe',
    );
    return {
      ok: false,
      mediaListStatus: 200,
      commentsStatus: comments.status,
      mediaId,
      errorBody: comments.raw,
      noteUk:
        comments.status === 400 || comments.status === 403
          ? 'GET /{media}/comments відхилено — повторіть OAuth із scope instagram_manage_comments (і pages_read_engagement).'
          : `GET /{media}/comments → HTTP ${comments.status}. Для App Review потрібен успішний виклик цього edge.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err, igUserId: igId }, 'IG comments probe exception');
    return {
      ok: false,
      noteUk: `Помилка тесту comments: ${msg}`,
    };
  }
}
