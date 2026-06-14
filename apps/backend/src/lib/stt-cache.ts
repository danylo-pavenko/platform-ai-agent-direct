import type { SttStatus } from './media-attachments.js';
import type { TranscribeResult } from '../services/transcribe.js';

export interface SttCacheEntry {
  result: TranscribeResult | null;
  sttStatus: SttStatus;
  expiresAt: number;
}

/** In-process STT cache — avoids duplicate whisper calls on webhook retries / races. */
const cache = new Map<string, SttCacheEntry>();

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function getCachedStt(storageKey: string): SttCacheEntry | undefined {
  const entry = cache.get(storageKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(storageKey);
    return undefined;
  }
  return entry;
}

export function setCachedStt(
  storageKey: string,
  result: TranscribeResult | null,
  sttStatus: SttStatus,
  ttlMs = DEFAULT_TTL_MS,
): void {
  cache.set(storageKey, {
    result,
    sttStatus,
    expiresAt: Date.now() + ttlMs,
  });
}

/** Test helper — clears in-memory cache between unit tests. */
export function clearSttCache(): void {
  cache.clear();
}
