import { prisma } from './prisma.js';
import { Prisma } from '../generated/prisma/client.js';

const RAW_BODY_MAX = 16 * 1024;
const INBOX_RETENTION = 500;

export type WebhookInboxKind = 'post' | 'verify_ok' | 'verify_fail';

export type WebhookInboxStatus =
  | 'unmatched'
  | 'forwarded'
  | 'partial'
  | 'hmac_skip'
  | 'forward_error'
  | 'ignored'
  | 'verify_ok'
  | 'verify_fail'
  | 'no_body';

export type ForwardResultRow = {
  tenantId: string;
  instanceId: string;
  url: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
  matchedId?: string | null;
  skippedReason?: 'hmac_missing' | 'hmac_failed';
};

export type RecordWebhookInboxInput = {
  kind: WebhookInboxKind;
  status: WebhookInboxStatus;
  objectType?: string | null;
  routingCandidateIds?: string[];
  debugCandidateIds?: string[];
  entrySummary?: Record<string, unknown> | null;
  matchedTenantIds?: string[];
  forwardResults?: ForwardResultRow[];
  signaturePresent?: boolean;
  rawBody?: Buffer | string | null;
};

export function truncateRawBody(raw: Buffer | string | null | undefined): string | null {
  if (raw == null) return null;
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length <= RAW_BODY_MAX) return text;
  return `${text.slice(0, RAW_BODY_MAX)}\n…[truncated ${text.length - RAW_BODY_MAX} bytes]`;
}

/** Messaging/standby previews for ops UI (no attachments). */
export function buildMessagingPreviews(body: {
  entry?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of body.entry ?? []) {
    for (const key of ['messaging', 'standby'] as const) {
      const events = entry[key];
      if (!Array.isArray(events)) continue;
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const e = ev as Record<string, unknown>;
        const sender = (e.sender as { id?: string } | undefined)?.id;
        const recipient = (e.recipient as { id?: string } | undefined)?.id;
        const message = e.message as
          | { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[] }
          | undefined;
        const text =
          typeof message?.text === 'string'
            ? message.text.slice(0, 120)
            : message?.attachments?.length
              ? `[attachments:${message.attachments.length}]`
              : e.reaction
                ? '[reaction]'
                : e.read
                  ? '[read]'
                  : e.postback
                    ? '[postback]'
                    : undefined;
        out.push({
          channel: key,
          entryId: entry.id,
          sender,
          recipient,
          mid: message?.mid,
          isEcho: message?.is_echo === true,
          text,
        });
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

async function pruneInbox(): Promise<void> {
  const keep = await prisma.webhookInboxEvent.findMany({
    orderBy: { receivedAt: 'desc' },
    take: INBOX_RETENTION,
    select: { id: true },
  });
  if (keep.length < INBOX_RETENTION) return;
  const keepIds = keep.map((r) => r.id);
  await prisma.webhookInboxEvent.deleteMany({
    where: { id: { notIn: keepIds } },
  });
}

/**
 * Persist a hub webhook observation. Never throws to callers — logs via console.
 * Fire-and-forget after Meta already got 200.
 */
export async function recordWebhookInboxEvent(input: RecordWebhookInboxInput): Promise<void> {
  try {
    await prisma.webhookInboxEvent.create({
      data: {
        kind: input.kind,
        status: input.status,
        objectType: input.objectType ?? null,
        routingCandidateIds: input.routingCandidateIds ?? [],
        debugCandidateIds: input.debugCandidateIds ?? [],
        entrySummary:
          input.entrySummary == null
            ? undefined
            : (input.entrySummary as Prisma.InputJsonValue),
        matchedTenantIds: input.matchedTenantIds ?? [],
        forwardResults: (input.forwardResults ?? []) as unknown as Prisma.InputJsonValue,
        signaturePresent: input.signaturePresent ?? false,
        rawBodyTruncated: truncateRawBody(input.rawBody),
      },
    });
    await pruneInbox();
  } catch (err) {
    console.warn('[webhook-inbox] failed to record event', err);
  }
}

export function derivePostStatus(opts: {
  objectType?: string;
  routingCandidateCount: number;
  matchedCount: number;
  forwardResults: ForwardResultRow[];
}): WebhookInboxStatus {
  if (opts.objectType && opts.objectType !== 'instagram') return 'ignored';
  if (opts.routingCandidateCount === 0) return 'unmatched';
  if (opts.matchedCount === 0) return 'unmatched';

  const attempted = opts.forwardResults.filter((r) => !r.skippedReason);
  const skippedHmac = opts.forwardResults.filter((r) => r.skippedReason);
  const ok = attempted.filter((r) => r.ok);
  const fail = attempted.filter((r) => !r.ok);

  if (attempted.length === 0 && skippedHmac.length > 0) return 'hmac_skip';
  if (ok.length > 0 && fail.length === 0 && skippedHmac.length === 0) return 'forwarded';
  if (ok.length > 0 && (fail.length > 0 || skippedHmac.length > 0)) return 'partial';
  if (fail.length > 0) return 'forward_error';
  if (skippedHmac.length > 0) return 'hmac_skip';
  return 'unmatched';
}
