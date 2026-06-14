import pino from 'pino';
import { config } from '../config.js';
import { getCachedStt, setCachedStt } from '../lib/stt-cache.js';
import { resolveStorageKey, getUploadsRoot } from './media.js';

const log = pino({ name: 'transcribe' });

export interface TranscribeResult {
  text: string;
  language?: string;
  durationSec?: number;
}

/**
 * Transcribe a local uploads storage key via the tenant faster-whisper HTTP service.
 */
export async function transcribeStorageKey(storageKey: string): Promise<TranscribeResult | null> {
  if (!config.STT_ENABLED) {
    return null;
  }

  const cached = getCachedStt(storageKey);
  if (cached) {
    if (cached.sttStatus === 'ok' && cached.result?.text) {
      log.debug({ storageKey }, 'STT cache hit');
      return cached.result;
    }
    if (cached.sttStatus === 'failed' || cached.sttStatus === 'too_long') {
      log.debug({ storageKey, sttStatus: cached.sttStatus }, 'STT cache hit (negative)');
      return null;
    }
  }

  const baseUrl = config.WHISPER_SERVICE_URL.replace(/\/$/, '');
  if (!baseUrl || !config.WHISPER_SERVICE_TOKEN) {
    log.warn('STT enabled but WHISPER_SERVICE_URL or WHISPER_SERVICE_TOKEN missing');
    return null;
  }

  let absolutePath: string;
  try {
    absolutePath = resolveStorageKey(storageKey);
  } catch (err) {
    log.warn({ err, storageKey }, 'Invalid storage key for transcription');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.WHISPER_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Whisper-Token': config.WHISPER_SERVICE_TOKEN,
      },
      // storageKey — whisper resolves under its own UPLOADS_DIR (avoids cwd mismatch).
      body: JSON.stringify({ storageKey }),
      signal: controller.signal,
    });

    if (res.status === 413) {
      log.info({ storageKey }, 'Voice note exceeds WHISPER_MAX_SECONDS — skipped');
      setCachedStt(storageKey, null, 'too_long');
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(
        {
          status: res.status,
          storageKey,
          uploadsRoot: getUploadsRoot(),
          body: body.slice(0, 300),
        },
        'Whisper STT failed',
      );
      setCachedStt(storageKey, null, 'failed');
      return null;
    }

    const data = (await res.json()) as TranscribeResult;
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) {
      log.info({ storageKey }, 'Whisper returned empty transcript');
      setCachedStt(storageKey, null, 'failed');
      return null;
    }

    const result: TranscribeResult = {
      text,
      language: data.language,
      durationSec: data.durationSec,
    };

    log.info(
      {
        storageKey,
        textLen: text.length,
        durationSec: result.durationSec,
        language: result.language,
      },
      'Voice transcribed',
    );

    setCachedStt(storageKey, result, 'ok');
    return result;
  } catch (err) {
    log.warn({ err, storageKey }, 'Whisper STT request error');
    setCachedStt(storageKey, null, 'failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Check local whisper /health (deploy diagnostics). */
export async function pingWhisperService(): Promise<boolean> {
  if (!config.STT_ENABLED) return false;
  const baseUrl = config.WHISPER_SERVICE_URL.replace(/\/$/, '');
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch whisper /health payload (uploadsDir alignment checks). */
export async function getWhisperHealth(): Promise<{
  ok: boolean;
  uploadsDir?: string;
  model?: string;
}> {
  if (!config.STT_ENABLED) return { ok: false };
  const baseUrl = config.WHISPER_SERVICE_URL.replace(/\/$/, '');
  if (!baseUrl) return { ok: false };
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { uploadsDir?: string; model?: string };
    return { ok: true, uploadsDir: data.uploadsDir, model: data.model };
  } catch {
    return { ok: false };
  }
}
