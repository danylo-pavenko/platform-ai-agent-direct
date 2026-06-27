import { prisma } from './prisma.js';

const CACHE_TTL_MS = 60_000;

interface FeatureFlagsCache {
  sendTypingIndicator: boolean;
  expiresAt: number;
}

let cache: FeatureFlagsCache | null = null;

export function invalidateFeatureFlagsCache(): void {
  cache = null;
}

async function loadFeatureFlags(): Promise<{ sendTypingIndicator: boolean }> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return { sendTypingIndicator: cache.sendTypingIndicator };
  }

  const row = await prisma.setting.findUnique({ where: { key: 'feature_flags' } });
  const flags = (row?.value ?? {}) as { send_typing_indicator?: boolean };
  const sendTypingIndicator = flags.send_typing_indicator === true;

  cache = { sendTypingIndicator, expiresAt: now + CACHE_TTL_MS };
  return { sendTypingIndicator };
}

export async function isSendTypingIndicatorEnabled(): Promise<boolean> {
  const flags = await loadFeatureFlags();
  return flags.sendTypingIndicator;
}
