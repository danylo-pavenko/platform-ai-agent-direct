import { checkPlatformAccess } from './platform-access.js';
import { prisma } from './prisma.js';

/** Days of IG inactivity after which expired tenants treat the client as "new". */
export const PLATFORM_GRANDFATHER_DAYS = 30;

const GRANDFATHER_MS = PLATFORM_GRANDFATHER_DAYS * 86_400_000;

export type BotAccessDenyReason = 'suspended' | 'expired_new' | 'expired_stale';

export type BotAccessDecision =
  | { allow: true }
  | { allow: false; reason: BotAccessDenyReason };

/**
 * Whether the IG bot may process a new inbound message for this client.
 *
 * When platform access is active — always allow.
 * When suspended — never allow.
 * When expired — allow only if the client had IG activity within the grandfather window.
 */
export async function evaluateBotAccessForClient(
  clientId: string,
  now = new Date(),
): Promise<BotAccessDecision> {
  const access = await checkPlatformAccess();
  if (access.allowed) return { allow: true };
  if (access.reason === 'suspended') return { allow: false, reason: 'suspended' };

  const lastActivity = await getClientLastIgActivityAt(clientId);
  if (!lastActivity) {
    return { allow: false, reason: 'expired_new' };
  }

  if (now.getTime() - lastActivity.getTime() > GRANDFATHER_MS) {
    return { allow: false, reason: 'expired_stale' };
  }

  return { allow: true };
}

async function getClientLastIgActivityAt(clientId: string): Promise<Date | null> {
  const row = await prisma.message.findFirst({
    where: {
      conversation: { clientId, channel: 'ig' },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}
