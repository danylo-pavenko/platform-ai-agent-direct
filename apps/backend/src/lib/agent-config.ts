/**
 * agent-config.ts
 *
 * Reads per-tenant agent behaviour knobs from the `settings` table.
 * Cached for 60s (same TTL as integration-config) to stay effectively
 * zero-cost on hot paths — the conversation handler reads this on every
 * inbound message.
 *
 * Stored under key `agent_config`. Any field may be absent — defaults
 * kick in so a fresh tenant works without explicit configuration.
 *
 *   {
 *     mode: 'sales' | 'leadgen' | 'booking',
 *     outOfHoursStrategy: 'warn_early' | 'defer_to_end',
 *     managerSlaHoursBusiness: number,  // hours within working time
 *     sessionFreshnessDays: number,     // B.3 — close stale convos beyond this
 *     responseDelayMinSeconds: number,  // human-like pause before Claude (0 = immediate)
 *     responseDelayMaxSeconds: number,  // random in [min, max]; max >= min
 *   }
 */
import { prisma } from './prisma.js';
import type { AgentMode } from './tool-definitions.js';

export type OutOfHoursStrategy = 'warn_early' | 'defer_to_end';

export const RESPONSE_DELAY_SEC_MAX = 60;

export interface AgentConfig {
  mode: AgentMode;
  outOfHoursStrategy: OutOfHoursStrategy;
  managerSlaHoursBusiness: number;
  sessionFreshnessDays: number;
  /** Inclusive lower bound for pause before generating a reply (seconds). */
  responseDelayMinSeconds: number;
  /** Inclusive upper bound; reply waits a random time in [min, max]. */
  responseDelayMaxSeconds: number;
}

const DEFAULTS: AgentConfig = {
  mode: 'sales',
  outOfHoursStrategy: 'warn_early',
  managerSlaHoursBusiness: 2,
  sessionFreshnessDays: 14,
  responseDelayMinSeconds: 0,
  responseDelayMaxSeconds: 0,
};

let _cache: AgentConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function clampDelaySec(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(RESPONSE_DELAY_SEC_MAX, Math.floor(n));
}

export function normalizeResponseDelayBounds(
  minRaw: unknown,
  maxRaw: unknown,
): { min: number; max: number } {
  let min = clampDelaySec(minRaw, DEFAULTS.responseDelayMinSeconds);
  let max = clampDelaySec(maxRaw, DEFAULTS.responseDelayMaxSeconds);
  if (max < min) max = min;
  return { min, max };
}

/**
 * Milliseconds to wait before Claude on this turn.
 * Both 0 → 0 (immediate). Equal → fixed delay. Range → uniform random.
 */
export function resolveResponseDelayMs(
  cfg: Pick<AgentConfig, 'responseDelayMinSeconds' | 'responseDelayMaxSeconds'>,
  random: () => number = Math.random,
): number {
  const { min, max } = normalizeResponseDelayBounds(
    cfg.responseDelayMinSeconds,
    cfg.responseDelayMaxSeconds,
  );
  if (max <= 0) return 0;
  if (min >= max) return min * 1000;
  const sec = min + random() * (max - min);
  return Math.round(sec * 1000);
}

export async function getAgentConfig(): Promise<AgentConfig> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const row = await prisma.setting.findUnique({
    where: { key: 'agent_config' },
  });

  const raw = (row?.value ?? {}) as Partial<AgentConfig>;
  const delay = normalizeResponseDelayBounds(
    raw.responseDelayMinSeconds,
    raw.responseDelayMaxSeconds,
  );

  _cache = {
    mode:
      raw.mode === 'leadgen'
        ? 'leadgen'
        : raw.mode === 'booking'
          ? 'booking'
          : 'sales',
    outOfHoursStrategy:
      raw.outOfHoursStrategy === 'defer_to_end' ? 'defer_to_end' : 'warn_early',
    managerSlaHoursBusiness:
      typeof raw.managerSlaHoursBusiness === 'number' && raw.managerSlaHoursBusiness > 0
        ? raw.managerSlaHoursBusiness
        : DEFAULTS.managerSlaHoursBusiness,
    sessionFreshnessDays:
      typeof raw.sessionFreshnessDays === 'number' && raw.sessionFreshnessDays > 0
        ? raw.sessionFreshnessDays
        : DEFAULTS.sessionFreshnessDays,
    responseDelayMinSeconds: delay.min,
    responseDelayMaxSeconds: delay.max,
  };
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateAgentConfigCache(): void {
  _cache = null;
  _cacheAt = 0;
}
