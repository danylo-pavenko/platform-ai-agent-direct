import { describe, expect, it, beforeEach } from 'vitest';
import { clearSttCache, getCachedStt, setCachedStt } from './stt-cache.js';

describe('stt-cache', () => {
  beforeEach(() => {
    clearSttCache();
  });

  it('caches success and negative whisper results', () => {
    setCachedStt('2026/06/x.m4a', { text: 'Привіт', language: 'uk' }, 'ok');
    expect(getCachedStt('2026/06/x.m4a')?.result?.text).toBe('Привіт');
    setCachedStt('2026/06/y.m4a', null, 'failed');
    expect(getCachedStt('2026/06/y.m4a')?.sttStatus).toBe('failed');
  });
});
