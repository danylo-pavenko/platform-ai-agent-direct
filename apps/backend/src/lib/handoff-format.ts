import type { StoredMediaAttachment } from './media-attachments.js';
import { adminConversationUrl } from './admin-urls.js';

export { adminConversationUrl };

export interface HandoffMessageLine {
  sender: string;
  text: string;
  isVoice: boolean;
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
