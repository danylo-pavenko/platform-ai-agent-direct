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
 *     mode: 'sales' | 'leadgen',
 *     outOfHoursStrategy: 'warn_early' | 'defer_to_end',
 *     managerSlaHoursBusiness: number,  // hours within working time
 *     sessionFreshnessDays: number,     // B.3 — close stale convos beyond this
 *   }
 */
import { prisma } from './prisma.js';
import type { AgentMode } from './tool-definitions.js';

export type OutOfHoursStrategy = 'warn_early' | 'defer_to_end';

export interface AgentConfig {
  mode: AgentMode;
  outOfHoursStrategy: OutOfHoursStrategy;
  managerSlaHoursBusiness: number;
  sessionFreshnessDays: number;
}

const DEFAULTS: AgentConfig = {
  mode: 'sales',
  outOfHoursStrategy: 'warn_early',
  managerSlaHoursBusiness: 2,
  sessionFreshnessDays: 14,
};

let _cache: AgentConfig | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getAgentConfig(): Promise<AgentConfig> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const row = await prisma.setting.findUnique({
    where: { key: 'agent_config' },
  });

  const raw = (row?.value ?? {}) as Partial<AgentConfig>;

  _cache = {
    mode: raw.mode === 'leadgen' ? 'leadgen' : 'sales',
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
  };
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateAgentConfigCache(): void {
  _cache = null;
  _cacheAt = 0;
}
