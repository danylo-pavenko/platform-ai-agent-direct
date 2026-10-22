/**
 * AES-256-GCM encrypt/decrypt for secrets stored in platform_admin (e.g. S3 keys).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

function keyBytes(): Buffer {
  const raw = (config.BACKUP_SECRETS_KEY || config.JWT_SECRET).trim();
  return createHash('sha256').update(raw).digest();
}

/** Returns base64(iv || tag || ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('Invalid ciphertext');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function maskSecretLast4(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim();
  if (t.length < 4) return '****';
  return `****${t.slice(-4)}`;
}
