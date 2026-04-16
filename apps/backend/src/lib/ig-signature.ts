import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta webhook payload signature (X-Hub-Signature-256).
 *
 * @param payload  Raw request body (string or Buffer)
 * @param signature  Value of X-Hub-Signature-256 header, e.g. "sha256=abc123…"
 * @param appSecret  Meta App Secret used as HMAC key
 * @returns true if signature is valid
 */
export function verifyIgSignature(
  payload: string | Buffer,
  signature: string,
  appSecret: string,
): boolean {
  if (!signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const expectedHex = createHmac('sha256', appSecret)
    .update(payload)
    .digest('hex');

  const expected = `sha256=${expectedHex}`;

  // Both strings must be the same length for timingSafeEqual
  if (signature.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
}
