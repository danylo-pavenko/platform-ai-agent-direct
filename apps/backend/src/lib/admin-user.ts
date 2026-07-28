import { randomBytes } from 'node:crypto';
import type { AdminRole } from '../generated/prisma/client.js';

export type AdminUserPublic = {
  id: string;
  username: string;
  role: AdminRole | string;
  displayName: string | null;
  tgUserId: string | null;
  tgUsername: string | null;
  isActive: boolean;
};

export type ConversationAssignee = {
  id: string;
  displayName: string | null;
  username: string;
  tgUsername: string | null;
};

/** Human-facing label for admin/manager in UI and Telegram. */
export function formatAdminLabel(user: {
  displayName?: string | null;
  tgUsername?: string | null;
  username: string;
}): string {
  const name = user.displayName?.trim();
  if (name) return name;
  const tg = user.tgUsername?.trim().replace(/^@/, '');
  if (tg) return `@${tg}`;
  return user.username;
}

export function toAdminUserPublic(user: {
  id: string;
  username: string;
  role: AdminRole | string;
  displayName?: string | null;
  tgUserId?: string | null;
  tgUsername?: string | null;
  isActive?: boolean;
}): AdminUserPublic {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName ?? null,
    tgUserId: user.tgUserId ?? null,
    tgUsername: user.tgUsername ?? null,
    isActive: user.isActive !== false,
  };
}

export function toAssignee(user: {
  id: string;
  username: string;
  displayName?: string | null;
  tgUsername?: string | null;
}): ConversationAssignee {
  return {
    id: user.id,
    displayName: user.displayName ?? null,
    username: user.username,
    tgUsername: user.tgUsername ?? null,
  };
}

/** Cryptographically random password for newly created managers (shown once). */
export function generateAdminPassword(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short unique-ish username like manager_a1b2c3d4 */
export function generateManagerUsername(): string {
  return `manager_${randomBytes(4).toString('hex')}`;
}

/** Short uppercase alphanumeric link code (excludes ambiguous 0/O/1/I). */
export function generateTelegramLinkCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out;
}

export const TELEGRAM_LINK_CODE_TTL_MS = 15 * 60 * 1000;
