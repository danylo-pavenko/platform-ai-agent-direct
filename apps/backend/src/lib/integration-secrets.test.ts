import { describe, expect, it } from 'vitest';
import {
  isHttpHeaderSafeToken,
  isMaskedIntegrationSecret,
  sanitizeIntegrationSecret,
} from './integration-secrets.js';

describe('integration-secrets', () => {
  it('detects masked placeholders', () => {
    expect(isMaskedIntegrationSecret('••••••')).toBe(true);
    expect(isMaskedIntegrationSecret('•••••• (збережено на сервері)')).toBe(true);
    expect(isMaskedIntegrationSecret('EAABsbCS1iHgBO...')).toBe(false);
  });

  it('rejects non-Latin-1 tokens for HTTP headers', () => {
    expect(isHttpHeaderSafeToken('Bearer-safe_token-123')).toBe(true);
    expect(isHttpHeaderSafeToken('••••••')).toBe(false);
  });

  it('sanitizes masked and invalid secrets to empty string', () => {
    expect(sanitizeIntegrationSecret('•••••• (збережено на сервері)')).toBe('');
    expect(sanitizeIntegrationSecret('real-token')).toBe('real-token');
  });
});
