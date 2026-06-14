import { describe, expect, it, beforeEach } from 'vitest';
import { clearSttCache, getCachedStt, setCachedStt } from './stt-cache.js';

describe('stt-cache', () => {
  beforeEach(() => {
    clearSttCache();
  });

  it('stores and retrieves transcript results', () => {
    setCachedStt('2026/06/x.m4a', { text: 'Привіт', language: 'uk' }, 'ok');
    const hit = getCachedStt('2026/06/x.m4a');
    expect(hit?.result?.text).toBe('Привіт');
    expect(hit?.sttStatus).toBe('ok');
  });

  it('caches negative results to avoid repeat whisper calls', () => {
    setCachedStt('2026/06/y.m4a', null, 'failed');
    expect(getCachedStt('2026/06/y.m4a')?.sttStatus).toBe('failed');
  });
});
