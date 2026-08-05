import type { AdminRole } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';

export const LAST_OWNER_ERROR = {
  error: 'Не можна залишити тенант без активного власника.',
  code: 'LAST_OWNER' as const,
};

export type AdminRoleChange = {
  role?: AdminRole | string;
  isActive?: boolean;
};

/**
 * Pure check: would applying `next` remove the last active owner?
 * `activeOwnerCount` is the current number of active owners in the DB.
 */
export function wouldRemoveLastActiveOwner(
  user: { role: AdminRole | string; isActive: boolean },
  next: AdminRoleChange,
  activeOwnerCount: number,
): boolean {
  const currentlyActiveOwner = user.role === 'owner' && user.isActive;
  if (!currentlyActiveOwner) return false;

  const nextRole = next.role ?? user.role;
  const nextActive = next.isActive ?? user.isActive;
  const stillActiveOwner = nextRole === 'owner' && nextActive;

  if (stillActiveOwner) return false;
  return activeOwnerCount <= 1;
}

/**
 * Throws nothing — returns LAST_OWNER payload when blocked, else null.
 */
export async function assertNotRemovingLastActiveOwner(
  user: { role: AdminRole | string; isActive: boolean },
  next: AdminRoleChange,
): Promise<typeof LAST_OWNER_ERROR | null> {
  const currentlyActiveOwner = user.role === 'owner' && user.isActive;
  if (!currentlyActiveOwner) return null;

  const nextRole = next.role ?? user.role;
  const nextActive = next.isActive ?? user.isActive;
  const stillActiveOwner = nextRole === 'owner' && nextActive;
  if (stillActiveOwner) return null;

  const activeOwnerCount = await prisma.adminUser.count({
    where: { role: 'owner', isActive: true },
  });
  if (activeOwnerCount <= 1) return LAST_OWNER_ERROR;
  return null;
}
