import type { StoredMediaAttachment } from './media-attachments.js';
import { adminConversationUrl } from './admin-urls.js';
import { isAgentTurnDebugNote } from './agent-turn-debug.js';
import { isSyntheticReactionText } from './ig-reaction-policy.js';
import { isVisionDebugNote } from './vision-debug-note.js';
import { effectiveChatDisplayName } from './client-person-name.js';

export { adminConversationUrl };

export interface HandoffMessageLine {
  sender: string;
  text: string;
  isVoice: boolean;
}

export type TelegramClientRef = {
  displayName?: string | null;
  igUsername?: string | null;
  igUserId?: string | null;
};

/** Name or @handle for manager cards — never a raw IGSID as if it were a username. */
export function formatTelegramClientLabel(client: TelegramClientRef): string {
  const name = effectiveChatDisplayName(client.displayName);
  if (name) return name;
  const handle = client.igUsername?.trim().replace(/^@/, '');
  if (handle) return `@${handle}`;
  return 'клієнт Instagram';
}

export function isHandoffServiceNote(
  text: string | null | undefined,
  sender?: string | null,
): boolean {
  if (sender === 'system') return true;
  if (!text) return false;
  return isAgentTurnDebugNote(text) || isVisionDebugNote(text);
}

const COALESCE_PREAMBLE_RE =
  /^Клієнт надіслав кілька повідомлень підряд[^\n]*\n/;

/** Drop the agent-only coalesce wrapper so managers see the actual bubbles. */
export function unwrapCoalescePreamble(text: string): string {
  const trimmed = text.trim();
  if (!COALESCE_PREAMBLE_RE.test(trimmed)) return text;
  const rest = trimmed.replace(COALESCE_PREAMBLE_RE, '').replace(/^\d+\)\s+/gm, '').trim();
  return rest || text;
}

function polishHandoffLine(line: HandoffMessageLine): HandoffMessageLine | null {
  const text = unwrapCoalescePreamble(line.text).trim();
  if (!text && !line.isVoice) return null;
  if (isSyntheticReactionText(text)) return null;
  return { ...line, text: text || line.text };
}

/** Group-facing transcript: customer + bot only, no debug dumps. */
export function selectManagerFacingHandoffLines(
  lines: HandoffMessageLine[],
): HandoffMessageLine[] {
  return lines
    .filter((line) => !isHandoffServiceNote(line.text, line.sender))
    .map(polishHandoffLine)
    .filter((line): line is HandoffMessageLine => line !== null);
}

export function selectHandoffServiceNotes(lines: HandoffMessageLine[]): HandoffMessageLine[] {
  return lines.filter((line) => isHandoffServiceNote(line.text, line.sender));
}

/**
 * Format a DB/API message row for Telegram handoff cards.
 * Voice notes show 🎤; transcript text is used when present.
 */
export function formatHandoffMessageLine(msg: {
  sender: string;
  text: string | null;
  mediaAttachments?: StoredMediaAttachment[] | null;
}): HandoffMessageLine | null {
  const audioItems = (msg.mediaAttachments ?? []).filter((a) => a.kind === 'audio');
  const isVoice = audioItems.length > 0;
  const transcript = audioItems
    .map((a) => a.transcript?.trim())
    .filter(Boolean)
    .join('\n');

  const body = (msg.text?.trim() || transcript || '').trim();
  if (!body && !isVoice) return null;

  if (body) {
    return {
      sender: msg.sender,
      text: isVoice ? `🎤 ${body}` : body,
      isVoice,
    };
  }

  return {
    sender: msg.sender,
    text: '🎤 [Голосове повідомлення — без транскрипції]',
    isVoice: true,
  };
}
