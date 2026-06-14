import pino from 'pino';
import { config } from '../config.js';
import type { StoredMediaAttachment, SttStatus } from '../lib/media-attachments.js';
import { getCachedStt } from '../lib/stt-cache.js';
import { transcribeStorageKey } from './transcribe.js';

const log = pino({ name: 'voice-ingest' });

/**
 * Run STT on ready audio attachments (Phase 2/3).
 * Mutates copies with transcript + sttStatus; non-audio items pass through unchanged.
 */
export async function transcribeAudioAttachments(
  attachments: StoredMediaAttachment[],
): Promise<StoredMediaAttachment[]> {
  if (!config.STT_ENABLED) {
    return attachments.map((a) =>
      a.kind === 'audio' ? { ...a, sttStatus: 'disabled' as const } : a,
    );
  }

  const out: StoredMediaAttachment[] = [];

  for (const item of attachments) {
    if (item.kind !== 'audio' || item.status !== 'ready' || !item.storageKey) {
      out.push(item);
      continue;
    }

    try {
      const cached = getCachedStt(item.storageKey);
      if (cached?.sttStatus === 'ok' && cached.result?.text) {
        out.push({
          ...item,
          transcript: cached.result.text,
          sttStatus: 'ok',
          durationSec: cached.result.durationSec,
        });
        continue;
      }
      if (cached && (cached.sttStatus === 'failed' || cached.sttStatus === 'too_long')) {
        out.push({ ...item, sttStatus: cached.sttStatus });
        continue;
      }

      const result = await transcribeStorageKey(item.storageKey);
      if (result?.text) {
        out.push({
          ...item,
          transcript: result.text,
          sttStatus: 'ok',
          durationSec: result.durationSec,
        });
      } else {
        out.push({ ...item, sttStatus: 'failed' });
      }
    } catch (err) {
      log.warn({ err, storageKey: item.storageKey }, 'Audio transcription failed');
      out.push({ ...item, sttStatus: 'failed' });
    }
  }

  return out;
}

/** Merge voice transcripts with optional typed caption from the same IG message. */
export function mergeMessageTextWithTranscripts(
  rawText: string,
  attachments: StoredMediaAttachment[],
): string {
  const transcripts = attachments
    .filter((a) => a.kind === 'audio' && a.transcript?.trim())
    .map((a) => a.transcript!.trim());

  const parts: string[] = [];
  if (rawText.trim()) parts.push(rawText.trim());
  if (transcripts.length > 0) parts.push(transcripts.join('\n'));

  return parts.join('\n');
}
