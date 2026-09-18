/**
 * Native Instagram / Business Suite page echoes (is_echo).
 * Inbound processMessageEvent still skips these; this module is the isolated path.
 */

export const IG_NATIVE_ECHO_KIND = 'ig_native_echo';
export const IG_ECHO_OWN_SEND_WINDOW_MS = 45_000;
export const HANDOFF_REASON_IG_NATIVE = 'Менеджер відповів з Instagram';

export type IgNativeEchoSource = 'webhook_echo' | 'ig_history_import';

export type IgNativeEchoContext = {
  kind: typeof IG_NATIVE_ECHO_KIND;
  source: IgNativeEchoSource;
};

export type EchoWebhookEvent = {
  mid: string;
  senderId: string;
  /** Client IGSID — never the business account. */
  recipientId: string;
  timestamp: number;
  text: string;
  attachmentTypes: string[];
  mediaUrls: string[];
};

type MessagingLike = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number | string;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isIgNativeEchoContext(value: unknown): boolean {
  const rec = asRecord(value);
  return rec?.kind === IG_NATIVE_ECHO_KIND;
}

export function buildIgNativeEchoContext(source: IgNativeEchoSource): IgNativeEchoContext {
  return { kind: IG_NATIVE_ECHO_KIND, source };
}

export function normalizeEchoText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function echoDisplayText(event: Pick<EchoWebhookEvent, 'text' | 'attachmentTypes'>): string {
  const text = normalizeEchoText(event.text);
  if (text) return text;
  const types = event.attachmentTypes.map((t) => t.toLowerCase());
  if (types.some((t) => t.includes('audio'))) return '[голос Instagram]';
  if (types.some((t) => t.includes('video'))) return '[відео Instagram]';
  if (types.some((t) => t.includes('image') || t === 'share' || t.includes('ig_post'))) {
    return '[медіа Instagram]';
  }
  if (types.length > 0) return '[вкладення Instagram]';
  return '';
}

export function textsMatchForEchoDedupe(a: string, b: string): boolean {
  const na = normalizeEchoText(a);
  const nb = normalizeEchoText(b);
  if (!na && !nb) return true;
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 8 && nb.includes(na)) return true;
  if (nb.length >= 8 && na.includes(nb)) return true;
  return false;
}

export function outboundHasGraphMessageId(
  row: { igMessageId?: string | null; igContext?: unknown },
  mid: string,
): boolean {
  if (row.igMessageId === mid) return true;
  const rec = asRecord(row.igContext);
  const extra = rec?.platformSendMids;
  return Array.isArray(extra) && extra.includes(mid);
}

export type EchoOwnSendMatchKind = 'mid' | 'heuristic';

export type EchoOwnSendMatch = {
  kind: EchoOwnSendMatchKind;
  messageId?: string;
};

export function matchOwnPlatformSend(
  echo: { mid: string; text: string },
  recentOutbound: Array<{
    id?: string;
    igMessageId?: string | null;
    igContext?: unknown;
    text?: string | null;
    createdAt: Date | string;
    sender?: string | null;
  }>,
  now = new Date(),
  windowMs = IG_ECHO_OWN_SEND_WINDOW_MS,
): EchoOwnSendMatch | null {
  for (const row of recentOutbound) {
    if (row.sender !== 'bot' && row.sender !== 'manager') continue;
    if (outboundHasGraphMessageId(row, echo.mid)) {
      return { kind: 'mid', messageId: row.id };
    }
  }

  const echoText = normalizeEchoText(echo.text);
  if (!echoText) return null;

  const cutoff = now.getTime() - windowMs;
  for (const row of recentOutbound) {
    if (row.sender !== 'bot' && row.sender !== 'manager') continue;
    const at = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < cutoff) continue;
    if (textsMatchForEchoDedupe(echoText, row.text ?? '')) {
      return { kind: 'heuristic', messageId: row.id };
    }
  }
  return null;
}

/** bot → take over (no Telegram). handoff/paused → persist only. */
export function echoConversationEffect(
  state: string | null | undefined,
): 'handoff' | 'persist_only' | 'skip' {
  if (state === 'bot') return 'handoff';
  if (state === 'handoff' || state === 'paused') return 'persist_only';
  return 'skip';
}

function messagingToEchoEvent(m: MessagingLike): EchoWebhookEvent | null {
  if (m.message?.is_echo !== true) return null;
  const mid = m.message.mid?.trim();
  const recipientId = m.recipient?.id?.trim();
  const senderId = m.sender?.id?.trim();
  if (!mid || !recipientId || !senderId) return null;

  const attachments = m.message.attachments ?? [];
  const mediaUrls = attachments
    .map((a) => a.payload?.url?.trim())
    .filter((url): url is string => Boolean(url));

  const tsRaw = m.timestamp;
  const timestamp =
    typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string' && tsRaw.trim()
        ? Number(tsRaw)
        : 0;

  return {
    mid,
    senderId,
    recipientId,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    text: m.message.text ?? '',
    attachmentTypes: attachments.map((a) => a.type ?? 'unknown'),
    mediaUrls,
  };
}

/**
 * Pull is_echo DMs from a Meta webhook body. Recipient is the client IGSID.
 */
export function extractEchoEventsFromWebhookBody(body: unknown): EchoWebhookEvent[] {
  const root = asRecord(body);
  if (!root) return [];
  const entries = root.entry;
  if (!Array.isArray(entries)) return [];

  const events: EchoWebhookEvent[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const rec = asRecord(entry);
    if (!rec) continue;

    const buckets: unknown[] = [];
    if (Array.isArray(rec.messaging)) buckets.push(...rec.messaging);
    if (Array.isArray(rec.standby)) buckets.push(...rec.standby);
    if (Array.isArray(rec.changes)) {
      for (const change of rec.changes) {
        const c = asRecord(change);
        const value = asRecord(c?.value);
        if (value?.message) buckets.push(value);
      }
    }

    for (const item of buckets) {
      const event = messagingToEchoEvent((asRecord(item) ?? {}) as MessagingLike);
      if (!event || seen.has(event.mid)) continue;
      seen.add(event.mid);
      events.push(event);
    }
  }

  return events;
}
